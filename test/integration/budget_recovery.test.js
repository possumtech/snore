/**
 * Budget recovery state machine tests.
 *
 * Covers:
 * - advanceRecovery: strike counter, prompt restoration, hard 413 at 3 strikes
 * - restoreSummarizedPrompts: orphaned summary-fidelity prompts restored at loop start
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { advanceRecovery } from "../../src/agent/AgentLoop.js";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

// ---------------------------------------------------------------------------
// advanceRecovery — pure state machine, no DB required
// ---------------------------------------------------------------------------

describe("advanceRecovery", () => {
	const TARGET = 4000;
	const PROMPT_PATH = "prompt://act/1";

	function mkRecovery(overrides = {}) {
		return {
			target: TARGET,
			promptPath: PROMPT_PATH,
			strikes: 0,
			lastTokens: 4500,
			...overrides,
		};
	}

	it("returns null action when recovery is null and no budgetRecovery", () => {
		const r = advanceRecovery(null, { assembledTokens: 3000 });
		assert.strictEqual(r.next, null);
		assert.strictEqual(r.action, null);
	});

	it("initialises recovery from budgetRecovery on first overflow", () => {
		const r = advanceRecovery(null, {
			assembledTokens: 4600,
			budgetRecovery: { target: TARGET, promptPath: PROMPT_PATH },
		});
		assert.deepStrictEqual(r.next, {
			target: TARGET,
			promptPath: PROMPT_PATH,
			strikes: 0,
			lastTokens: 4600,
		});
		assert.strictEqual(r.action, null);
	});

	it("tightens target on re-overflow, does not strike", () => {
		const existing = mkRecovery({ strikes: 1, lastTokens: 4500 });
		const r = advanceRecovery(existing, {
			assembledTokens: 4600,
			budgetRecovery: { target: 3800, promptPath: PROMPT_PATH },
		});
		assert.strictEqual(r.next?.target, 3800);
		assert.strictEqual(r.next?.strikes, 0, "strikes reset on re-overflow");
	});

	it("returns restore action when tokens drop to target", () => {
		const rec = mkRecovery({ lastTokens: 4500 });
		const r = advanceRecovery(rec, { assembledTokens: TARGET });
		assert.strictEqual(r.next, null);
		assert.strictEqual(r.action, "restore");
		assert.strictEqual(r.promptPath, PROMPT_PATH);
	});

	it("returns restore action when tokens drop below target", () => {
		const rec = mkRecovery({ lastTokens: 4500 });
		const r = advanceRecovery(rec, { assembledTokens: TARGET - 100 });
		assert.strictEqual(r.action, "restore");
	});

	it("increments strike on no-progress turn", () => {
		const rec = mkRecovery({ strikes: 0, lastTokens: 4500 });
		const r = advanceRecovery(rec, { assembledTokens: 4500 });
		assert.strictEqual(r.next?.strikes, 1);
		assert.strictEqual(r.action, null);
	});

	it("resets strikes when tokens decrease", () => {
		const rec = mkRecovery({ strikes: 2, lastTokens: 4500 });
		const r = advanceRecovery(rec, { assembledTokens: 4400 });
		assert.strictEqual(r.next?.strikes, 0, "strikes reset on reduction");
		assert.strictEqual(r.action, null);
	});

	it("returns hard413 at 3 consecutive no-progress turns", () => {
		let rec = mkRecovery({ strikes: 0, lastTokens: 4500 });
		// Turn 1: no progress
		rec = advanceRecovery(rec, { assembledTokens: 4500 }).next;
		assert.strictEqual(rec.strikes, 1);
		// Turn 2: no progress
		rec = advanceRecovery(rec, { assembledTokens: 4500 }).next;
		assert.strictEqual(rec.strikes, 2);
		// Turn 3: no progress → hard 413
		const r = advanceRecovery(rec, { assembledTokens: 4500 });
		assert.strictEqual(r.action, "hard413");
		assert.strictEqual(r.next, null);
	});

	it("does not hard413 if reduction interrupts strike sequence", () => {
		let rec = mkRecovery({ strikes: 0, lastTokens: 4500 });
		rec = advanceRecovery(rec, { assembledTokens: 4500 }).next; // strike 1
		rec = advanceRecovery(rec, { assembledTokens: 4400 }).next; // reduction → reset
		rec = advanceRecovery(rec, { assembledTokens: 4400 }).next; // strike 1 again
		rec = advanceRecovery(rec, { assembledTokens: 4400 }).next; // strike 2
		const r = advanceRecovery(rec, { assembledTokens: 4400 }); // strike 3
		assert.strictEqual(r.action, "hard413");
	});

	it("null promptPath on hard413", () => {
		const rec = mkRecovery({ strikes: 2, lastTokens: 4500 });
		const r = advanceRecovery(rec, { assembledTokens: 4500 });
		assert.strictEqual(r.action, "hard413");
		assert.strictEqual(r.promptPath, null);
	});
});

// ---------------------------------------------------------------------------
// restoreSummarizedPrompts — DB operation
// ---------------------------------------------------------------------------

describe("restoreSummarizedPrompts", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create("budget_recovery");
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("restores prompt entry demoted to summary back to full", async () => {
		const { runId } = await tdb.seedRun({ alias: "rsp_1" });

		await store.upsert(
			runId,
			1,
			"prompt://act/1",
			"full prompt text here",
			200,
			{
				fidelity: "summary",
			},
		);

		const before = await tdb.db.get_known_entries.all({ run_id: runId });
		assert.strictEqual(
			before.find((e) => e.path === "prompt://act/1")?.fidelity,
			"summary",
		);

		await store.restoreSummarizedPrompts(runId);

		const after = await tdb.db.get_known_entries.all({ run_id: runId });
		assert.strictEqual(
			after.find((e) => e.path === "prompt://act/1")?.fidelity,
			"full",
		);
	});

	it("does not touch prompt entries already at full fidelity", async () => {
		const { runId } = await tdb.seedRun({ alias: "rsp_2" });

		await store.upsert(runId, 1, "prompt://act/1", "full prompt", 200, {
			fidelity: "full",
		});

		await store.restoreSummarizedPrompts(runId);

		const entries = await tdb.db.get_known_entries.all({ run_id: runId });
		assert.strictEqual(
			entries.find((e) => e.path === "prompt://act/1")?.fidelity,
			"full",
		);
	});

	it("does not touch non-prompt entries at summary fidelity", async () => {
		const { runId } = await tdb.seedRun({ alias: "rsp_3" });

		await store.upsert(runId, 1, "known://some-fact", "fact body", 200, {
			fidelity: "summary",
		});

		await store.restoreSummarizedPrompts(runId);

		const entries = await tdb.db.get_known_entries.all({ run_id: runId });
		assert.strictEqual(
			entries.find((e) => e.path === "known://some-fact")?.fidelity,
			"summary",
			"non-prompt entry untouched",
		);
	});

	it("restores tokens to tokens_full on restored prompt", async () => {
		const { runId } = await tdb.seedRun({ alias: "rsp_4" });

		const body = "a".repeat(200);
		await store.upsert(runId, 1, "prompt://act/1", body, 200);
		await store.setFidelity(runId, "prompt://act/1", "summary");

		await store.restoreSummarizedPrompts(runId);

		const after = await tdb.db.get_known_entries.all({ run_id: runId });
		const entry = after.find((e) => e.path === "prompt://act/1");
		assert.strictEqual(entry.tokens, entry.tokens_full, "tokens = tokens_full");
	});
});
