/**
 * Handler dispatch integration test.
 *
 * Covers @dispatch_path, @plugins_handler, @get_plugin,
 * @xml_parser, @failure_reporting, @plugins_handler_outcomes —
 * the record → dispatch → state-change loop that turns parsed XML
 * commands into entries with outcomes. View projection
 * (@plugins_views) is tested separately in engine.test.js and
 * tool_visibility.test.js, which exercise the full/summary
 * rendering path.
 *
 * Proves the record→dispatch→state-change loop:
 * 1. XmlParser produces commands (@xml_parser — parser is the
 *    syntax layer this test feeds)
 * 2. Commands recorded as entries at "full" state
 * 3. Handlers dispatched via ToolRegistry
 * 4. Handlers finalize their own log entry's body+state+outcome
 *    on success or failure (@failure_reporting,
 *    @plugins_handler_outcomes — the action entry IS its outcome).
 * 5. Multiple handlers per scheme run in priority order
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import createHooks from "../../src/hooks/Hooks.js";
import RummyContext from "../../src/hooks/RummyContext.js";
import { registerPlugins } from "../../src/plugins/index.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;
let PROJECT;

function makeRummy(
	hooks,
	db,
	store,
	{ sequence = 1, contextSize = 50000 } = {},
) {
	const hookRoot = {
		tag: "turn",
		attrs: {},
		content: null,
		children: [
			{ tag: "system", attrs: {}, content: null, children: [] },
			{ tag: "context", attrs: {}, content: null, children: [] },
			{ tag: "user", attrs: {}, content: null, children: [] },
			{ tag: "assistant", attrs: {}, content: null, children: [] },
		],
	};
	return new RummyContext(hookRoot, {
		hooks,
		db,
		store,
		project: PROJECT,
		type: "act",
		sequence,
		runId: RUN_ID,
		turnId: 1,
		noRepo: false,
		contextSize,
		systemPrompt: "test",
		loopPrompt: "",
	});
}

describe("Handler dispatch", () => {
	let tdb, store, hooks;

	before(async () => {
		tdb = await TestDb.create();
		store = new Entries(tdb.db);
		const seed = await tdb.seedRun({ alias: "dispatch_1" });
		RUN_ID = seed.runId;
		PROJECT = { id: seed.projectId, path: "/tmp/test", name: "Test" };

		hooks = createHooks();
		const { dirname, join } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const pluginsDir = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../src/plugins",
		);
		await registerPlugins([pluginsDir], hooks);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("get handler", () => {
		it("promotes target and writes a concise log so the model sees the action", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "src/target.js",
				body: "const x = 1;",
				state: "resolved",
				visibility: "summarized",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "get",
				path: "get://src%2Ftarget.js",
				body: "",
				attributes: { path: "src/target.js" },
				state: "resolved",
				resultPath: "get://src%2Ftarget.js",
			};

			await hooks.tools.dispatch("get", entry, rummy);

			const state = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/target.js",
			});
			assert.strictEqual(
				state.visibility,
				"visible",
				"target promoted to full",
			);

			// The log entry is the model's proof in <log> that the fetch
			// already happened; absence made the model re-issue identical
			// gets until the cyclic-fingerprint detector struck the run.
			const log = await store.getBody(RUN_ID, entry.resultPath);
			assert.ok(log, "get:// log written");
			assert.ok(log.includes("promoted"), `log says promoted, got: ${log}`);
		});

		it("writes log on not-found so the attempt is recorded", async () => {
			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "get",
				path: "get://missing.js",
				body: "",
				attributes: { path: "src/missing.js" },
				state: "resolved",
				resultPath: "get://missing.js",
			};

			await hooks.tools.dispatch("get", entry, rummy);

			const log = await store.getBody(RUN_ID, entry.resultPath);
			assert.ok(log, "not-found log written");
			assert.ok(log.includes("not found"), "log says not found");
		});
	});

	describe("set handler — edit mode", () => {
		it("applies patch and sets proposed for files", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/edit_me.js",
				body: "const port = 3000;",
				state: "resolved",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "set",
				path: "log://turn_1/set/src%2Fedit_me.js",
				body: "",
				attributes: {
					path: "src/edit_me.js",
					blocks: [
						{ search: "const port = 3000;", replace: "const port = 8080;" },
					],
				},
				state: "resolved",
				resultPath: "log://turn_1/set/src%2Fedit_me.js",
			};

			await hooks.tools.dispatch("set", entry, rummy);
			await hooks.proposal.prepare.emit({ rummy, recorded: [entry] });

			// Bare-file edits land as a `proposed` log entry at the
			// dispatch's resultPath. The body carries the canonicalized
			// SEARCH/REPLACE merge for the materializer; attrs.path names
			// the target file. Acceptance applies the merge to the file
			// (proposal.accepted handler), not the dispatch.
			const logPath = "log://turn_1/set/src%2Fedit_me.js";
			const attrs = await store.getAttributes(RUN_ID, logPath);
			assert.equal(attrs.path, "src/edit_me.js");
			assert.ok(
				attrs.merge.includes("<<<<<<< SEARCH"),
				"attributes.merge has SEARCH/REPLACE format",
			);
			assert.ok(attrs.merge.includes("8080"), "merge has new content");

			const logState = await store.getState(RUN_ID, logPath);
			assert.equal(logState.state, "proposed", "bare-file edit is proposed");
		});

		// Regression: fuzzy-matched edits used to silently no-op at
		// materialization. #processEdit ran fuzzy and produced a
		// correct patch, but the stored attrs.merge used the original
		// (pre-fuzzy) search/replace text. #materializeFile re-applied
		// via String.replace which only does direct match — search not
		// found → file unchanged. Now #processEdit also stores the
		// authoritative patched body in attrs.patched, and
		// #materializeFile uses it directly.
		it("fuzzy-matched edits land on materialization (no silent no-op)", async () => {
			// File body has 4-space indent.
			const original = "function add(a, b) {\n    return a + b;\n}\n";
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/fuzzy.js",
				body: original,
				state: "resolved",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const logPath = "log://turn_1/set/src%2Ffuzzy.js";
			// SEARCH has tab indent (mismatched). Fuzzy matcher should heal.
			const entry = {
				scheme: "set",
				path: logPath,
				body: "",
				attributes: {
					path: "src/fuzzy.js",
					blocks: [
						{
							search: "function add(a, b) {\n\treturn a + b;\n}",
							replace: "function add(a, b) {\n\treturn a + b + 1;\n}",
						},
					],
				},
				state: "resolved",
				resultPath: logPath,
			};
			await hooks.tools.dispatch("set", entry, rummy);

			const attrs = await store.getAttributes(RUN_ID, logPath);
			assert.ok(attrs.patched, "attrs.patched stored");
			assert.ok(attrs.patched.includes("a + b + 1"), "patched has new content");

			// Fire proposal.accepted to trigger #materializeFile.
			await hooks.proposal.accepted.emit({
				runId: RUN_ID,
				attrs,
				db: tdb.db,
				entries: store,
				path: logPath,
				projectRoot: null,
			});

			const fileBody = await store.getBody(RUN_ID, "src/fuzzy.js");
			assert.ok(
				fileBody.includes("a + b + 1"),
				`materialization produced patched body, got: ${fileBody}`,
			);
		});

		// Regression: mv/cp from bare-file to bare-file used to materialize
		// the destination only for cp (which built a merge attribute);
		// mv's proposal omitted both `path: to` and `merge`, so
		// #materializeFile's gate skipped it. mv's #onAccepted rm'd the
		// source, leaving no trace of the file. Both now build a
		// whole-body-replace merge that flows through the shared
		// materializer; visibility= flows with the proposal too.
		it("bare→bare mv materializes destination and honors visibility", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/old_name.js",
				body: "const x = 1;\n",
				state: "resolved",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const logPath = "log://turn_1/mv/src%2Fold_name.js";
			const entry = {
				scheme: "mv",
				path: logPath,
				body: "",
				attributes: {
					path: "src/old_name.js",
					to: "src/new_name.js",
					visibility: "summarized",
				},
				state: "resolved",
				resultPath: logPath,
			};
			await hooks.tools.dispatch("mv", entry, rummy);

			const attrs = await store.getAttributes(RUN_ID, logPath);
			await hooks.proposal.accepted.emit({
				runId: RUN_ID,
				attrs,
				db: tdb.db,
				entries: store,
				path: logPath,
				projectRoot: null,
			});

			const newBody = await store.getBody(RUN_ID, "src/new_name.js");
			assert.equal(newBody, "const x = 1;\n", "destination materialized");
			const oldBody = await store.getBody(RUN_ID, "src/old_name.js");
			assert.equal(oldBody, null, "source removed");
			const newState = await store.getState(RUN_ID, "src/new_name.js");
			assert.equal(newState.visibility, "summarized", "visibility honored");
		});

		it("bare→bare cp materializes destination and honors visibility", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/source.js",
				body: "const y = 2;\n",
				state: "resolved",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const logPath = "log://turn_1/cp/src%2Fsource.js";
			const entry = {
				scheme: "cp",
				path: logPath,
				body: "",
				attributes: {
					path: "src/source.js",
					to: "src/copy.js",
					visibility: "archived",
				},
				state: "resolved",
				resultPath: logPath,
			};
			await hooks.tools.dispatch("cp", entry, rummy);

			const attrs = await store.getAttributes(RUN_ID, logPath);
			await hooks.proposal.accepted.emit({
				runId: RUN_ID,
				attrs,
				db: tdb.db,
				entries: store,
				path: logPath,
				projectRoot: null,
			});

			const copyBody = await store.getBody(RUN_ID, "src/copy.js");
			assert.equal(copyBody, "const y = 2;\n", "destination materialized");
			const srcBody = await store.getBody(RUN_ID, "src/source.js");
			assert.equal(srcBody, "const y = 2;\n", "source preserved");
			const copyState = await store.getState(RUN_ID, "src/copy.js");
			assert.equal(copyState.visibility, "archived", "visibility honored");
		});

		it("two edits to the same file produce two independent proposals", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/math.txt",
				body: "a + 4 = 6\n7 - a = \nb / 4 = 3\na + b = \n",
				state: "resolved",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });

			const path1 = "log://turn_1/set/src%2Fmath.txt";
			const path2 = "log://turn_1/set/src%2Fmath.txt_1";
			const entry1 = {
				scheme: "set",
				path: path1,
				body: "",
				attributes: {
					path: "src/math.txt",
					search: "7 - a = ",
					replace: "7 - a = 5",
				},
				state: "resolved",
				resultPath: path1,
			};
			await hooks.tools.dispatch("set", entry1, rummy);

			const entry2 = {
				scheme: "set",
				path: path2,
				body: "",
				attributes: {
					path: "src/math.txt",
					search: "a + b = ",
					replace: "a + b = 14",
				},
				state: "resolved",
				resultPath: path2,
			};
			await hooks.tools.dispatch("set", entry2, rummy);

			await hooks.proposal.prepare.emit({ rummy, recorded: [entry1, entry2] });

			// Each edit is its own proposal — predictable, parallel-friendly,
			// no cross-dispatch canonical-entry state. Materialization (on
			// proposal.accepted) applies merges to the actual file.
			const a1 = await store.getAttributes(RUN_ID, path1);
			assert.equal(a1.path, "src/math.txt");
			assert.ok(
				a1.merge.includes("7 - a = 5"),
				"first proposal has first edit",
			);

			const a2 = await store.getAttributes(RUN_ID, path2);
			assert.equal(a2.path, "src/math.txt");
			assert.ok(
				a2.merge.includes("a + b = 14"),
				"second proposal has second edit",
			);

			const s1 = await store.getState(RUN_ID, path1);
			const s2 = await store.getState(RUN_ID, path2);
			assert.equal(s1.state, "proposed");
			assert.equal(s2.state, "proposed");
		});

		it("applies patch immediately for known:// entries", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "known://config",
				body: "port=3000",
				state: "resolved",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "set",
				path: "set://known%3A%2F%2Fconfig",
				body: "",
				attributes: {
					path: "known://config",
					search: "3000",
					replace: "8080",
				},
				state: "resolved",
				resultPath: "set://known%3A%2F%2Fconfig",
			};

			await hooks.tools.dispatch("set", entry, rummy);

			const updated = await store.getBody(RUN_ID, "known://config");
			assert.strictEqual(
				updated,
				"port=8080",
				"known entry patched immediately",
			);
		});
	});

	describe("sh handler", () => {
		it("sets entry to proposed", async () => {
			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const resultPath = await store.slugPath(RUN_ID, "sh", "npm test");
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: resultPath,
				body: "npm test",
				state: "resolved",
				attributes: { command: "npm test" },
			});

			const entry = {
				scheme: "sh",
				path: resultPath,
				body: "npm test",
				attributes: { command: "npm test" },
				state: "resolved",
				resultPath,
			};

			await hooks.tools.dispatch("sh", entry, rummy);

			const row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: resultPath,
			});
			assert.strictEqual(row.state, "proposed", "sh entry set to proposed");
		});
	});

	describe("env handler", () => {
		it("sets entry to proposed", async () => {
			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const resultPath = await store.slugPath(RUN_ID, "env", "node --version");
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: resultPath,
				body: "node --version",
				state: "resolved",
				attributes: { command: "node --version" },
			});

			const entry = {
				scheme: "env",
				path: resultPath,
				body: "node --version",
				attributes: { command: "node --version" },
				state: "resolved",
				resultPath,
			};

			await hooks.tools.dispatch("env", entry, rummy);

			const row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: resultPath,
			});
			assert.strictEqual(row.state, "proposed", "env entry set to proposed");
		});
	});

	describe("set visibility control", () => {
		it("archives entry via stored attribute", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "known://demote_me",
				body: "some data",
				state: "resolved",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "set",
				path: "set://known%3A%2F%2Fdemote_me",
				body: "",
				attributes: { path: "known://demote_me", visibility: "archived" },
				state: "resolved",
				resultPath: "set://known%3A%2F%2Fdemote_me",
			};

			await hooks.tools.dispatch("set", entry, rummy);

			const state = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "known://demote_me",
			});
			assert.strictEqual(state.visibility, "archived", "target archived");
		});
	});

	describe("rm handler", () => {
		it("proposes deletion for files", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/doomed.js",
				body: "content",
				state: "resolved",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "rm",
				path: "rm://src%2Fdoomed.js",
				body: "",
				attributes: { path: "src/doomed.js" },
				state: "resolved",
				resultPath: "rm://src%2Fdoomed.js",
			};

			await hooks.tools.dispatch("rm", entry, rummy);

			const entries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const result = entries.find((e) => e.path === "rm://src/doomed.js");
			assert.strictEqual(result.state, "proposed", "file delete is proposed");
		});

		it("immediately removes known:// entries", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "known://ephemeral",
				body: "temp",
				state: "resolved",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "rm",
				path: "rm://known%3A%2F%2Fephemeral",
				body: "",
				attributes: { path: "known://ephemeral" },
				state: "resolved",
				resultPath: "rm://known%3A%2F%2Fephemeral",
			};

			await hooks.tools.dispatch("rm", entry, rummy);

			const gone = await store.getBody(RUN_ID, "known://ephemeral");
			assert.strictEqual(gone, null, "known entry removed immediately");
		});

		it("multi-match produces one aggregate result entry", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 2,
				path: "known://bulk_a",
				body: "data-a",
				state: "resolved",
			});
			await store.set({
				runId: RUN_ID,
				turn: 2,
				path: "known://bulk_b",
				body: "data-b",
				state: "resolved",
			});
			await store.set({
				runId: RUN_ID,
				turn: 2,
				path: "known://bulk_c",
				body: "data-c",
				state: "resolved",
			});

			const allBefore = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const rmCountBefore = allBefore.filter((e) => e.scheme === "rm").length;

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 2 });
			const resultPath = "rm://known%3A%2F%2Fbulk_*";
			const entry = {
				scheme: "rm",
				path: resultPath,
				body: "",
				attributes: { path: "known://bulk_*" },
				state: "resolved",
				resultPath,
			};

			await hooks.tools.dispatch("rm", entry, rummy);

			// All three entries removed
			const remaining = await store.getEntriesByPattern(
				RUN_ID,
				"known://bulk_*",
				null,
			);
			assert.strictEqual(remaining.length, 0, "all matched entries removed");

			// Exactly one new rm:// log entry (the aggregate)
			const allAfter = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const rmEntries = allAfter.filter((e) => e.scheme === "rm");
			assert.strictEqual(
				rmEntries.length - rmCountBefore,
				1,
				"one aggregate result entry",
			);
			const rmEntry = rmEntries.find((e) => e.body?.includes("known://bulk_a"));
			assert.ok(rmEntry, "aggregate entry exists");
			assert.strictEqual(rmEntry.state, "resolved");
			assert.ok(
				rmEntry.body.includes("known://bulk_b"),
				"body lists removed paths",
			);
			assert.ok(
				rmEntry.body.includes("known://bulk_c"),
				"body lists removed paths",
			);
		});
	});

	describe("priority ordering", () => {
		it("lower priority handlers run first", async () => {
			const order = [];

			hooks.tools.onHandle(
				"get",
				async () => {
					order.push("plugin-at-5");
				},
				5,
			);

			// Core get handler is already at priority 10
			// We just need to verify our priority-5 handler ran first
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/priority_test.js",
				body: "x",
				state: "resolved",
				visibility: "summarized",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "get",
				path: "get://priority_test",
				body: "",
				attributes: { path: "src/priority_test.js" },
				state: "resolved",
				resultPath: "get://priority_test",
			};

			await hooks.tools.dispatch("get", entry, rummy);
			assert.strictEqual(order[0], "plugin-at-5", "priority 5 ran first");
		});

		it("handler returning false stops the chain", async () => {
			const testHooks = createHooks();
			const order = [];

			testHooks.tools.ensureTool("test_tool");

			testHooks.tools.onHandle(
				"test_tool",
				async () => {
					order.push("first");
					return false;
				},
				1,
			);

			testHooks.tools.onHandle(
				"test_tool",
				async () => {
					order.push("second");
				},
				10,
			);

			const rummy = makeRummy(testHooks, tdb.db, store, { sequence: 1 });
			await testHooks.tools.dispatch("test_tool", {}, rummy);

			assert.deepStrictEqual(order, ["first"], "chain stopped after false");
		});
	});

	// Behaviors previously characterized via real-LLM tests in
	// record_behavior.test.js. Each test exercises a single dispatch
	// path with a synthetic entry — fast, deterministic, no model.
	describe("plugin handler behaviors (@unknown_plugin, @known_plugin, @update_plugin, @upsert_semantics)", () => {
		it("unknown handler dedupes on identical body within a run", async () => {
			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 10 });
			const body = "What is the database schema?";
			const entry = {
				scheme: "unknown",
				path: "unknown://result",
				body,
				attributes: { summary: "schema,question" },
				state: "resolved",
				resultPath: "unknown://result",
			};

			await hooks.tools.dispatch("unknown", entry, rummy);
			await hooks.tools.dispatch("unknown", { ...entry }, rummy);

			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const matches = all.filter(
				(e) => e.scheme === "unknown" && e.body === body,
			);
			assert.strictEqual(
				matches.length,
				1,
				`identical unknown body collapses to one entry, got ${matches.length}`,
			);
		});

		it("known handler rejects a body over RUMMY_MAX_ENTRY_TOKENS", async () => {
			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 11 });
			// Cap is 512 in .env.example; build a body well over so the
			// test isn't sensitive to the exact tokenizer accounting.
			const oversized = "word ".repeat(2000);
			const entry = {
				scheme: "known",
				path: "known://oversized",
				body: oversized,
				attributes: { summary: "oversized" },
				state: "resolved",
				resultPath: "known://oversized",
			};

			await hooks.tools.dispatch("known", entry, rummy);

			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const failed = all.find(
				(e) => e.state === "failed" && e.outcome?.startsWith("overflow:"),
			);
			assert.ok(
				failed,
				"oversize known produces a failed entry with overflow:N outcome",
			);
			const accepted = all.find(
				(e) => e.path === "known://oversized" && e.state === "resolved",
			);
			assert.strictEqual(
				accepted,
				undefined,
				"oversize body never reaches resolved at the requested path",
			);
		});

		it("update handler writes a log entry under log://turn_N/update/", async () => {
			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 12 });
			const entry = {
				scheme: "update",
				path: "log://turn_12/update/test_status",
				body: "working through unknowns",
				attributes: { status: 144 },
				state: "resolved",
				resultPath: "log://turn_12/update/test_status",
			};

			await hooks.tools.dispatch("update", entry, rummy);

			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const updateLog = all.find(
				(e) =>
					e.scheme === "log" &&
					/^log:\/\/turn_12\/update\//.test(e.path) &&
					e.body === "working through unknowns",
			);
			assert.ok(
				updateLog,
				"update emission lands at log://turn_N/update/<slug>",
			);
		});
	});
});
