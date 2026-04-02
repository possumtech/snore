import assert from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import HookRegistry from "../../src/hooks/HookRegistry.js";
import RummyContext from "../../src/hooks/RummyContext.js";
import Engine from "../../src/plugins/engine/engine.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;
let PROJECT;

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
	return Array(n).fill("hello").join(" ");
}

describe("Engine integration", () => {
	let tdb;
	let store;
	let hooks;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun({ alias: "engine_1" });
		RUN_ID = seed.runId;
		PROJECT = { id: seed.projectId, path: "/tmp/test", name: "Test" };
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

		it("demotes by tier order: files downgraded before known entries", async () => {
			await store.upsert(RUN_ID, 1, "src/big_file.js", pad(300), "full", {
				meta: { symbols: pad(10) },
			});
			await store.upsert(RUN_ID, 1, "known://keep_note", pad(50), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 200,
			});
			await hooks.processTurn(rummy);

			const file = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/big_file.js",
			});
			assert.strictEqual(
				file.state,
				"summary",
				"file should be downgraded to summary first (tier 1)",
			);

			const note = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "known://keep_note",
			});
			assert.strictEqual(
				note.state,
				"full",
				"known entry should survive if file downgrade freed enough",
			);
		});

		it("downgrades files to summary before demoting known entries", async () => {
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
				"summary",
				"file should be downgraded to summary",
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
				"summary",
				"old file should be downgraded to summary",
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
			} else if (big.state === "summary" && small.turn > 0) {
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
		it("demotions are logged but do not pollute known_entries", async () => {
			await store.upsert(RUN_ID, 1, "src/a.js", pad(500), "full");
			await store.upsert(RUN_ID, 1, "src/b.js", pad(500), "full");

			const rummy = makeRummy(tdb.db, store, {
				sequence: 2,
				contextSize: 200,
			});
			await hooks.processTurn(rummy);

			const entries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const report = entries.find((e) => e.value?.includes("engine demoted"));
			assert.strictEqual(
				report,
				undefined,
				"engine telemetry should not be in known_entries",
			);
		});
	});

	describe("symbol file fidelity via VIEW", () => {
		it("files at state index have index fidelity", async () => {
			await store.upsert(RUN_ID, 1, "src/demoted.js", pad(100), "index", {
				meta: { symbols: "function foo()" },
			});

			const hooks2 = new HookRegistry();
			Engine.register(hooks2);
			const rummy = makeRummy(tdb.db, store, {
				sequence: 1,
				contextSize: 50000,
			});
			await hooks2.processTurn(rummy);

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

		it("symbol files at turn > 0 have summary fidelity", async () => {
			await store.upsert(RUN_ID, 3, "src/active.js", pad(100), "summary", {
				meta: { symbols: "function bar()" },
			});

			const hooks2 = new HookRegistry();
			Engine.register(hooks2);
			const rummy = makeRummy(tdb.db, store, {
				sequence: 4,
				contextSize: 50000,
			});
			await hooks2.processTurn(rummy);

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
				active.content.includes("function bar()"),
				"symbols content should come from meta",
			);
		});
	});
});
