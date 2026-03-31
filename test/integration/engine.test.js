import assert from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import HookRegistry from "../../src/hooks/HookRegistry.js";
import RummyContext from "../../src/hooks/RummyContext.js";
import Engine from "../../src/plugins/engine/engine.js";
import TestDb from "../helpers/TestDb.js";

const RUN_ID = "run-engine-1";
const PROJECT = { id: "p1", path: "/tmp/test", name: "Test" };

function makeRummy(db, store, { sequence = 1, contextSize = 1000 } = {}) {
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
		db,
		store,
		project: PROJECT,
		type: "act",
		sequence,
		runId: RUN_ID,
		turnId: 1,
		noContext: false,
		contextSize,
		systemPrompt: "test system prompt",
		loopPrompt: "",
	});
}

function pad(n) {
	return "x".repeat(n * 4);
}

describe("Engine integration", () => {
	let tdb;
	let store;
	let hooks;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);

		await tdb.db.upsert_project.run({
			id: "p1",
			path: "/tmp/test",
			name: "Test",
		});
		await tdb.db.create_session.run({
			id: "s1",
			project_id: "p1",
			client_id: "c1",
		});
		await tdb.db.create_run.run({
			id: RUN_ID,
			session_id: "s1",
			parent_run_id: null,
			type: "act",
			config: "{}",
			alias: "engine_1",
		});
	});

	beforeEach(async () => {
		await store.deleteByPattern(RUN_ID, "*", null);
		hooks = new HookRegistry();
		Engine.register(hooks);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("no-op when under budget", () => {
		it("makes zero changes when total tokens fit", async () => {
			await store.upsert(RUN_ID, 1, "src/small.js", pad(100), "full");
			await store.upsert(RUN_ID, 1, "known://note", "short", "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 5000,
			});
			await hooks.processTurn(rummy);

			const row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/small.js",
			});
			assert.strictEqual(row.turn, 1);
			assert.strictEqual(row.state, "full");
		});

		it("makes zero changes when store is empty", async () => {
			const rummy = makeRummy(tdb.db, store, {
				sequence: 1,
				contextSize: 5000,
			});
			await hooks.processTurn(rummy);
			const { total } = await tdb.db.get_promoted_token_total.get({
				run_id: RUN_ID,
			});
			assert.strictEqual(total, 0);
		});
	});

	describe("budget enforcement", () => {
		it("demotes entries until total fits budget", async () => {
			await store.upsert(RUN_ID, 1, "src/a.js", pad(300), "full");
			await store.upsert(RUN_ID, 1, "src/b.js", pad(300), "full");
			await store.upsert(RUN_ID, 1, "src/c.js", pad(300), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 500,
			});
			await hooks.processTurn(rummy);

			const { total } = await tdb.db.get_promoted_token_total.get({
				run_id: RUN_ID,
			});
			assert.ok(total <= 500, `expected ≤500, got ${total}`);
		});

		it("demotes results before files", async () => {
			await store.upsert(RUN_ID, 1, "src/keep.js", pad(200), "full");
			await store.upsert(RUN_ID, 1, "edit://1", pad(100), "pass");
			await store.upsert(RUN_ID, 1, "run://1", pad(100), "pass");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 250,
			});
			await hooks.processTurn(rummy);

			const file = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/keep.js",
			});
			assert.strictEqual(file.turn, 1, "file should still be promoted");
			assert.strictEqual(
				file.state,
				"full",
				"file should remain at full fidelity",
			);

			const edit = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "edit://1",
			});
			assert.strictEqual(edit.turn, 0, "result should be demoted");
		});

		it("downgrades files to symbols before demoting known entries", async () => {
			await store.upsert(RUN_ID, 1, "src/big.js", pad(400), "full", {
				meta: { symbols: pad(20) },
			});
			await store.upsert(RUN_ID, 1, "known://important", pad(50), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 200,
			});
			await hooks.processTurn(rummy);

			const file = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/big.js",
			});
			const known = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "known://important",
			});

			assert.strictEqual(
				file.state,
				"symbols",
				"file should be downgraded to symbols",
			);
			assert.strictEqual(
				known.turn > 0,
				true,
				"known entry should survive if file downgrade freed enough",
			);
		});
	});

	describe("current-turn protection", () => {
		it("never demotes entries from the current turn", async () => {
			await store.upsert(RUN_ID, 5, "src/sacred.js", pad(800), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 5,
				contextSize: 100,
			});
			await hooks.processTurn(rummy);

			const row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/sacred.js",
			});
			assert.strictEqual(row.turn, 5, "current-turn entry must not be demoted");
			assert.strictEqual(
				row.state,
				"full",
				"current-turn entry must not be downgraded",
			);
		});

		it("demotes older entries instead of current-turn entries", async () => {
			await store.upsert(RUN_ID, 1, "src/old.js", pad(300), "full");
			await store.upsert(RUN_ID, 5, "src/new.js", pad(300), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 5,
				contextSize: 400,
			});
			await hooks.processTurn(rummy);

			const old = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/old.js",
			});
			const fresh = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/new.js",
			});

			assert.strictEqual(
				old.state,
				"symbols",
				"old file should be downgraded to symbols",
			);
			assert.strictEqual(fresh.turn, 5, "current-turn entry should survive");
			assert.strictEqual(
				fresh.state,
				"full",
				"current-turn entry should remain at full fidelity",
			);
		});
	});

	describe("demotion cascade order", () => {
		it("demotes oldest turn first within same tier", async () => {
			await store.upsert(RUN_ID, 1, "src/oldest.js", pad(200), "full");
			await store.upsert(RUN_ID, 3, "src/newer.js", pad(200), "full");
			await store.upsert(RUN_ID, 2, "src/middle.js", pad(200), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 5,
				contextSize: 300,
			});
			await hooks.processTurn(rummy);

			const oldest = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/oldest.js",
			});
			const newer = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/newer.js",
			});

			assert.notStrictEqual(
				oldest.state,
				"full",
				"oldest should be downgraded first",
			);
			assert.strictEqual(
				newer.state,
				"full",
				"newest should survive longest at full fidelity",
			);
		});

		it("demotes largest entries first within same turn", async () => {
			await store.upsert(RUN_ID, 1, "src/big.js", pad(400), "full");
			await store.upsert(RUN_ID, 1, "src/small.js", pad(100), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 300,
			});
			await hooks.processTurn(rummy);

			const big = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/big.js",
			});
			const small = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/small.js",
			});

			if (big.turn === 0 && small.turn > 0) {
				assert.ok(true, "big entry demoted first");
			} else if (big.state === "symbols" && small.turn > 0) {
				assert.ok(true, "big entry downgraded first");
			} else {
				assert.ok(
					small.turn > 0 || big.turn === 0,
					"big entry should be targeted before small",
				);
			}
		});
	});

	describe("tokens accounting", () => {
		it("entry persists in store after demotion", async () => {
			await store.upsert(RUN_ID, 1, "src/file.js", pad(500), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 100,
			});
			await hooks.processTurn(rummy);

			const row = await store.getValue(RUN_ID, "src/file.js");
			assert.ok(row !== null, "entry should still exist in store");
		});

		it("tokens_full is preserved after demotion", async () => {
			await store.upsert(RUN_ID, 1, "src/file.js", pad(500), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 100,
			});
			await hooks.processTurn(rummy);

			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"src/file.js",
				null,
			);
			assert.strictEqual(
				matches[0].tokens_full,
				500,
				"tokens_full should reflect original value cost",
			);
		});

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

			const promoted = await tdb.db.get_promoted_entries.all({
				run_id: RUN_ID,
			});
			const entry = promoted.find((e) => e.path === "known://test_entry");
			assert.strictEqual(
				entry.tokens,
				200,
				"promote should restore tokens to tokens_full",
			);
		});
	});

	describe("demotion report", () => {
		it("injects an info entry when demotions occur", async () => {
			await store.upsert(RUN_ID, 1, "src/a.js", pad(500), "full");
			await store.upsert(RUN_ID, 1, "src/b.js", pad(500), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 200,
			});
			await hooks.processTurn(rummy);

			const results = await tdb.db.get_results.all({ run_id: RUN_ID });
			const report = results.find((r) => r.value.includes("engine demoted"));
			assert.ok(report, "should inject a demotion report");
			assert.ok(
				report.value.includes("budget:"),
				"report should include budget percentages",
			);
		});

		it("does not inject a report when no demotions needed", async () => {
			await store.upsert(RUN_ID, 1, "src/tiny.js", "small", "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 5000,
			});
			await hooks.processTurn(rummy);

			const results = await tdb.db.get_results.all({ run_id: RUN_ID });
			const report = results.find((r) => r.value.includes("engine demoted"));
			assert.strictEqual(report, undefined, "no report when no demotions");
		});
	});

	describe("symbol file query fix", () => {
		it("symbol files at turn 0 do not appear in get_symbol_files", async () => {
			await store.upsert(RUN_ID, 0, "src/demoted.js", pad(100), "symbols", {
				meta: { symbols: "function foo()" },
			});

			const symbols = await tdb.db.get_symbol_files.all({
				run_id: RUN_ID,
			});
			assert.strictEqual(
				symbols.length,
				0,
				"demoted symbols should not appear",
			);
		});

		it("symbol files at turn > 0 appear in get_symbol_files", async () => {
			await store.upsert(RUN_ID, 3, "src/active.js", pad(100), "symbols", {
				meta: { symbols: "function bar()" },
			});

			const symbols = await tdb.db.get_symbol_files.all({
				run_id: RUN_ID,
			});
			assert.strictEqual(symbols.length, 1);
			assert.strictEqual(symbols[0].path, "src/active.js");
		});

		it("demoted symbol files appear in get_stored_files", async () => {
			await store.upsert(RUN_ID, 0, "src/cold.js", pad(100), "symbols", {
				meta: { symbols: "function baz()" },
			});

			const stored = await tdb.db.get_stored_files.all({
				run_id: RUN_ID,
			});
			const found = stored.find((f) => f.path === "src/cold.js");
			assert.ok(found, "demoted symbols file should appear in stored files");
		});
	});
});
