/**
 * Budget demotion integration tests.
 *
 * Covers:
 * - demote_turn_entries: all full entries at turn N → summary + 413
 *   (every scheme except budget, system, prompt, instructions)
 * - Budget entries survive demotion
 * - Error-state entries survive demotion
 * - Other turns are not affected
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("Budget demotion", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create("budget_demotion");
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("demote_turn_entries SQL", () => {
		it("demotes full data entries at turn N to summary with status 413", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_1" });

			await store.upsert(runId, 3, "known://fact-a", "fact content", 200, {
				fidelity: "full",
			});
			await store.upsert(runId, 3, "known://fact-b", "more facts", 200, {
				fidelity: "full",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 3 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const a = entries.find((e) => e.path === "known://fact-a");
			const b = entries.find((e) => e.path === "known://fact-b");

			assert.strictEqual(a.fidelity, "summary", "fact-a demoted to summary");
			assert.strictEqual(a.status, 413, "fact-a status set to 413");
			assert.strictEqual(b.fidelity, "summary", "fact-b demoted to summary");
			assert.strictEqual(b.status, 413, "fact-b status set to 413");
		});

		it("demotes logging entries at the same turn", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_log" });

			await store.upsert(runId, 5, "get://turn_5/file.js", "file body", 200, {
				fidelity: "full",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 5 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "get://turn_5/file.js");
			assert.strictEqual(entry.fidelity, "summary", "logging entry demoted");
			assert.strictEqual(entry.status, 413, "logging entry status 413");
		});

		it("does not demote entries from other turns", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_2" });

			await store.upsert(runId, 2, "known://turn2-fact", "earlier fact", 200, {
				fidelity: "full",
			});
			await store.upsert(runId, 4, "known://turn4-fact", "later fact", 200, {
				fidelity: "full",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 3 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const t2 = entries.find((e) => e.path === "known://turn2-fact");
			const t4 = entries.find((e) => e.path === "known://turn4-fact");
			assert.strictEqual(t2.fidelity, "full", "turn 2 entry untouched");
			assert.strictEqual(t4.fidelity, "full", "turn 4 entry untouched");
		});

		it("does not demote entries already in error state", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_3" });

			await store.upsert(runId, 6, "known://errored", "body", 400, {
				fidelity: "full",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 6 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "known://errored");
			assert.strictEqual(entry.fidelity, "full", "4xx entry not demoted");
		});

		it("demotes budget entries too (onView renders full at summary)", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_budget" });

			await store.upsert(runId, 7, "budget://1/7", "413 report", 200, {
				fidelity: "full",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 7 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "budget://1/7");
			assert.strictEqual(entry.fidelity, "summary", "budget entry demoted");
		});
	});
});
