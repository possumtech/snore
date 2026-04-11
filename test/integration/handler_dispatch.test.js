/**
 * Handler dispatch integration test.
 *
 * Proves the record→dispatch→state-change loop:
 * 1. XmlParser produces commands
 * 2. Commands recorded as entries at "full" state
 * 3. Handlers dispatched via ToolRegistry
 * 4. Handlers update entry state (proposed, pass, read, etc.)
 * 5. Multiple handlers per scheme run in priority order
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
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
		store = new KnownStore(tdb.db);
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
		it("promotes target and writes confirmation", async () => {
			await store.upsert(RUN_ID, 0, "src/target.js", "const x = 1;", 200, {
				fidelity: "index",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "get",
				path: "get://src%2Ftarget.js",
				body: "",
				attributes: { path: "src/target.js" },
				status: 200,
				resultPath: "get://src%2Ftarget.js",
			};

			await hooks.tools.dispatch("get", entry, rummy);

			const state = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/target.js",
			});
			assert.strictEqual(state.fidelity, "full", "target promoted to full");

			const result = await store.getBody(RUN_ID, entry.resultPath);
			assert.ok(result.includes("tokens"), "confirmation written");
		});
	});

	describe("set handler — edit mode", () => {
		it("applies patch and sets proposed for files", async () => {
			await store.upsert(
				RUN_ID,
				1,
				"src/edit_me.js",
				"const port = 3000;",
				200,
			);

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "set",
				path: "set://src%2Fedit_me.js",
				body: "",
				attributes: {
					path: "src/edit_me.js",
					blocks: [
						{ search: "const port = 3000;", replace: "const port = 8080;" },
					],
				},
				status: 200,
				resultPath: "set://src%2Fedit_me.js",
			};

			await hooks.tools.dispatch("set", entry, rummy);
			await hooks.turn.proposing.emit({ rummy, recorded: [entry] });

			// body = original content
			const resultBody = await store.getBody(RUN_ID, "set://src/edit_me.js");
			assert.ok(
				resultBody.includes("const port = 3000"),
				"body is original content",
			);

			// attributes.patch = udiff for client
			const attrs = await store.getAttributes(RUN_ID, "set://src/edit_me.js");
			assert.ok(
				attrs.patch.includes("---") && attrs.patch.includes("+++"),
				"attributes.patch is udiff",
			);
			assert.ok(attrs.patch.includes("8080"), "udiff shows new content");

			// attributes.merge = git conflict for model
			assert.ok(
				attrs.merge.includes("<<<<<<< SEARCH"),
				"attributes.merge has git conflict format",
			);
			assert.ok(attrs.merge.includes("8080"), "merge shows new content");

			// File entries → proposed
			const entries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const writeResult = entries.find(
				(e) => e.path === "set://src/edit_me.js",
			);
			assert.strictEqual(writeResult.status, 202, "file edit is proposed");
		});

		it("merges multiple edits to the same file into one proposal", async () => {
			await store.upsert(
				RUN_ID,
				1,
				"src/math.txt",
				"a + 4 = 6\n7 - a = \nb / 4 = 3\na + b = \n",
				200,
			);

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });

			const entry1 = {
				scheme: "set",
				path: "set://src/math.txt",
				body: "",
				attributes: {
					path: "src/math.txt",
					search: "7 - a = ",
					replace: "7 - a = 5",
				},
				status: 200,
				resultPath: "set://src/math.txt",
			};
			await hooks.tools.dispatch("set", entry1, rummy);

			const entry2 = {
				scheme: "set",
				path: "set://src/math.txt",
				body: "",
				attributes: {
					path: "src/math.txt",
					search: "a + b = ",
					replace: "a + b = 14",
				},
				status: 200,
				resultPath: "set://src/math.txt",
			};
			await hooks.tools.dispatch("set", entry2, rummy);

			await hooks.turn.proposing.emit({ rummy, recorded: [entry1, entry2] });

			const body = await store.getBody(RUN_ID, "set://src/math.txt");
			assert.ok(body.includes("a + 4 = 6"), "body is original content");

			const attrs = await store.getAttributes(RUN_ID, "set://src/math.txt");
			assert.ok(attrs.patch.includes("7 - a = 5"), "patch has first edit");
			assert.ok(attrs.patch.includes("a + b = 14"), "patch has second edit");
			assert.ok(attrs.merge.includes("7 - a = 5"), "merge has first block");
			assert.ok(attrs.merge.includes("a + b = 14"), "merge has second block");

			const row = await store.getState(RUN_ID, "set://src/math.txt");
			assert.strictEqual(row.status, 202, "merged result is proposed");
		});

		it("applies patch immediately for known:// entries", async () => {
			await store.upsert(RUN_ID, 1, "known://config", "port=3000", 200);

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
				status: 200,
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
			await store.upsert(RUN_ID, 1, resultPath, "npm test", 200, {
				attributes: { command: "npm test" },
			});

			const entry = {
				scheme: "sh",
				path: resultPath,
				body: "npm test",
				attributes: { command: "npm test" },
				status: 200,
				resultPath,
			};

			await hooks.tools.dispatch("sh", entry, rummy);

			const row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: resultPath,
			});
			assert.strictEqual(row.status, 202, "sh entry set to proposed");
		});
	});

	describe("env handler", () => {
		it("sets entry to proposed", async () => {
			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const resultPath = await store.slugPath(RUN_ID, "env", "node --version");
			await store.upsert(RUN_ID, 1, resultPath, "node --version", 200, {
				attributes: { command: "node --version" },
			});

			const entry = {
				scheme: "env",
				path: resultPath,
				body: "node --version",
				attributes: { command: "node --version" },
				status: 200,
				resultPath,
			};

			await hooks.tools.dispatch("env", entry, rummy);

			const row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: resultPath,
			});
			assert.strictEqual(row.status, 202, "env entry set to proposed");
		});
	});

	describe("set fidelity control", () => {
		it("archives entry via stored attribute", async () => {
			await store.upsert(RUN_ID, 1, "known://demote_me", "some data", 200);

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "set",
				path: "set://known%3A%2F%2Fdemote_me",
				body: "",
				attributes: { path: "known://demote_me", fidelity: "archive" },
				status: 200,
				resultPath: "set://known%3A%2F%2Fdemote_me",
			};

			await hooks.tools.dispatch("set", entry, rummy);

			const state = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "known://demote_me",
			});
			assert.strictEqual(state.fidelity, "archive", "target archived");
		});
	});

	describe("rm handler", () => {
		it("proposes deletion for files", async () => {
			await store.upsert(RUN_ID, 1, "src/doomed.js", "content", 200);

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "rm",
				path: "rm://src%2Fdoomed.js",
				body: "",
				attributes: { path: "src/doomed.js" },
				status: 200,
				resultPath: "rm://src%2Fdoomed.js",
			};

			await hooks.tools.dispatch("rm", entry, rummy);

			const entries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const result = entries.find((e) => e.path === "rm://src/doomed.js");
			assert.strictEqual(result.status, 202, "file delete is proposed");
		});

		it("immediately removes known:// entries", async () => {
			await store.upsert(RUN_ID, 1, "known://ephemeral", "temp", 200);

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "rm",
				path: "rm://known%3A%2F%2Fephemeral",
				body: "",
				attributes: { path: "known://ephemeral" },
				status: 200,
				resultPath: "rm://known%3A%2F%2Fephemeral",
			};

			await hooks.tools.dispatch("rm", entry, rummy);

			const gone = await store.getBody(RUN_ID, "known://ephemeral");
			assert.strictEqual(gone, null, "known entry removed immediately");
		});

		it("multi-match produces one aggregate result entry", async () => {
			await store.upsert(RUN_ID, 2, "known://bulk_a", "data-a", 200);
			await store.upsert(RUN_ID, 2, "known://bulk_b", "data-b", 200);
			await store.upsert(RUN_ID, 2, "known://bulk_c", "data-c", 200);

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 2 });
			const resultPath = "rm://known%3A%2F%2Fbulk_*";
			const entry = {
				scheme: "rm",
				path: resultPath,
				body: "",
				attributes: { path: "known://bulk_*" },
				status: 200,
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

			// Exactly one aggregate rm:// log entry
			const allEntries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const rmEntries = allEntries.filter((e) =>
				e.path.startsWith("rm://known%3A%2F%2Fbulk"),
			);
			assert.strictEqual(rmEntries.length, 1, "one aggregate result entry");
			assert.strictEqual(rmEntries[0].status, 200);
			assert.ok(
				rmEntries[0].body.includes("known://bulk_a"),
				"body lists removed paths",
			);
			assert.ok(
				rmEntries[0].body.includes("known://bulk_b"),
				"body lists removed paths",
			);
			assert.ok(
				rmEntries[0].body.includes("known://bulk_c"),
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
			await store.upsert(RUN_ID, 1, "src/priority_test.js", "x", 200, {
				fidelity: "index",
			});

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "get",
				path: "get://priority_test",
				body: "",
				attributes: { path: "src/priority_test.js" },
				status: 200,
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
});
