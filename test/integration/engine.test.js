import assert from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import createHooks from "../../src/hooks/Hooks.js";
import CoreToolsPlugin from "../../src/plugins/tools/tools.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;
let _PROJECT;

function pad(n) {
	return Array(n).fill("hello").join(" ");
}

describe("Engine integration", () => {
	let tdb;
	let store;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun({ alias: "engine_1" });
		RUN_ID = seed.runId;
		_PROJECT = { id: seed.projectId, project_root: "/tmp/test", name: "Test" };
	});

	beforeEach(async () => {
		await store.deleteByPattern(RUN_ID, "*", null);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("context materialization", () => {
		it("materializes entries into turn_context", async () => {
			await store.upsert(RUN_ID, 1, "src/small.js", pad(100), "full");
			await store.upsert(RUN_ID, 1, "known://note", "short", "full");

			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 1,
				systemPrompt: "test system prompt",
			});

			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 1,
			});
			assert.ok(rows.length > 0, "turn_context should have entries");
			const file = rows.find((r) => r.path === "src/small.js");
			assert.ok(file, "file should be in turn_context");
		});

		it("includes system prompt as first entry", async () => {
			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 1,
				systemPrompt: "test system prompt",
			});

			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 1,
			});
			const system = rows.find((r) => r.path === "system://prompt");
			assert.ok(system, "system prompt should be in turn_context");
			assert.strictEqual(
				system.ordinal,
				0,
				"system prompt should be ordinal 0",
			);
			assert.ok(
				system.body.includes("test system prompt"),
				"system prompt body should match",
			);
		});
	});

	describe("tokens accounting", () => {
		it("promote restores tokens to tokens_full", async () => {
			await store.upsert(RUN_ID, 1, "known://test_entry", pad(200), "full");
			await store.demote(RUN_ID, "known://test_entry");

			const demoted = await store.getEntriesByPattern(
				RUN_ID,
				"known://test_entry",
				null,
			);
			assert.strictEqual(
				demoted[0].tokens_full,
				200,
				"tokens_full preserved after demote",
			);

			await store.promote(RUN_ID, "known://test_entry", 3);

			const promoted = await store.getEntriesByPattern(
				RUN_ID,
				"known://test_entry",
				null,
			);
			assert.strictEqual(
				promoted[0].tokens_full,
				200,
				"tokens_full preserved after promote",
			);
		});
	});

	describe("symbol file fidelity via VIEW", () => {
		it("files at state index have index fidelity", async () => {
			await store.upsert(RUN_ID, 1, "src/demoted.js", pad(100), "index", {
				attributes: { symbols: "function foo()" },
			});

			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 1,
				systemPrompt: "test system prompt",
			});

			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 1,
			});
			const demoted = rows.find((r) => r.path === "src/demoted.js");
			assert.ok(demoted, "index file should appear in turn_context");
			assert.strictEqual(
				demoted.fidelity,
				"index",
				"index state should have index fidelity",
			);
		});

		it("summary files have summary fidelity with body passed through", async () => {
			await store.upsert(
				RUN_ID,
				3,
				"src/active.js",
				"function bar() {}",
				"summary",
			);

			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 4,
				systemPrompt: "test system prompt",
			});

			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 4,
			});
			const active = rows.find((r) => r.path === "src/active.js");
			assert.ok(active, "active summary file should appear in turn_context");
			assert.strictEqual(
				active.fidelity,
				"summary",
				"active symbols should have summary fidelity",
			);
			assert.ok(
				active.body.includes("function bar()"),
				"body should pass through at summary fidelity",
			);
		});
	});

	describe("tool:// materialization", () => {
		it("only materializes tools with docs", async () => {
			const hooks = createHooks();
			CoreToolsPlugin.register(hooks);
			// Core tools have no docs — nothing should be materialized
			await hooks.tools.materialize(store, RUN_ID, 1);

			const readTool = await store.getBody(RUN_ID, "tool://read");
			assert.strictEqual(
				readTool,
				null,
				"tool://read should not exist (no docs)",
			);
		});
	});
});
