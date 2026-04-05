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
		noContext: false,
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
			await store.upsert(RUN_ID, 0, "src/target.js", "const x = 1;", "index");

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "get",
				path: "get://src%2Ftarget.js",
				body: "",
				attributes: { path: "src/target.js" },
				state: "full",
				resultPath: "get://src%2Ftarget.js",
			};

			await hooks.tools.dispatch("get", entry, rummy);

			const state = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/target.js",
			});
			assert.strictEqual(state.state, "full", "target promoted to full");

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
				"full",
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
				state: "full",
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
			assert.strictEqual(
				writeResult.state,
				"proposed",
				"file edit is proposed",
			);
		});

		it("merges multiple edits to the same file into one proposal", async () => {
			await store.upsert(
				RUN_ID,
				1,
				"src/math.txt",
				"a + 4 = 6\n7 - a = \nb / 4 = 3\na + b = \n",
				"full",
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
				state: "full",
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
				state: "full",
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
			assert.strictEqual(row.state, "proposed", "merged result is proposed");
		});

		it("applies patch immediately for known:// entries", async () => {
			await store.upsert(RUN_ID, 1, "known://config", "port=3000", "full");

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
				state: "full",
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
			await store.upsert(RUN_ID, 1, resultPath, "npm test", "full", {
				attributes: { command: "npm test" },
			});

			const entry = {
				scheme: "sh",
				path: resultPath,
				body: "npm test",
				attributes: { command: "npm test" },
				state: "full",
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
		it("sets entry to pass", async () => {
			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const resultPath = await store.slugPath(RUN_ID, "env", "node --version");
			await store.upsert(RUN_ID, 1, resultPath, "node --version", "full", {
				attributes: { command: "node --version" },
			});

			const entry = {
				scheme: "env",
				path: resultPath,
				body: "node --version",
				attributes: { command: "node --version" },
				state: "full",
				resultPath,
			};

			await hooks.tools.dispatch("env", entry, rummy);

			const row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: resultPath,
			});
			assert.strictEqual(row.state, "pass", "env entry set to pass");
		});
	});

	describe("store handler", () => {
		it("demotes target and writes confirmation", async () => {
			await store.upsert(RUN_ID, 1, "known://demote_me", "some data", "full");

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "store",
				path: "store://known%3A%2F%2Fdemote_me",
				body: "",
				attributes: { path: "known://demote_me" },
				state: "full",
				resultPath: "store://known%3A%2F%2Fdemote_me",
			};

			await hooks.tools.dispatch("store", entry, rummy);

			const state = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "known://demote_me",
			});
			assert.strictEqual(state.state, "stored", "target demoted");
		});
	});

	describe("rm handler", () => {
		it("proposes deletion for files", async () => {
			await store.upsert(RUN_ID, 1, "src/doomed.js", "content", "full");

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "rm",
				path: "rm://src%2Fdoomed.js",
				body: "",
				attributes: { path: "src/doomed.js" },
				state: "full",
				resultPath: "rm://src%2Fdoomed.js",
			};

			await hooks.tools.dispatch("rm", entry, rummy);

			const entries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const result = entries.find((e) => e.path === "rm://src/doomed.js");
			assert.strictEqual(result.state, "proposed", "file delete is proposed");
		});

		it("immediately removes known:// entries", async () => {
			await store.upsert(RUN_ID, 1, "known://ephemeral", "temp", "full");

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "rm",
				path: "rm://known%3A%2F%2Fephemeral",
				body: "",
				attributes: { path: "known://ephemeral" },
				state: "full",
				resultPath: "rm://known%3A%2F%2Fephemeral",
			};

			await hooks.tools.dispatch("rm", entry, rummy);

			const gone = await store.getBody(RUN_ID, "known://ephemeral");
			assert.strictEqual(gone, null, "known entry removed immediately");
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
			await store.upsert(RUN_ID, 1, "src/priority_test.js", "x", "index");

			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			const entry = {
				scheme: "get",
				path: "get://priority_test",
				body: "",
				attributes: { path: "src/priority_test.js" },
				state: "full",
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
