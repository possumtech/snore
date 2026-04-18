/**
 * Budget demotion integration tests.
 *
 * Covers:
 * - demote_turn_entries: all promoted entries at turn N → fidelity=demoted.
 *   Status is preserved: a successful operation stays at its original
 *   status (200), because budget demotion is a lifecycle event, not a
 *   failure of the body operation. The budget:// entry is the canonical
 *   record of the panic event.
 * - Error-state entries are not re-demoted
 * - Other turns are not affected
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Repository from "../../src/agent/Repository.js";
import TestDb from "../helpers/TestDb.js";

describe("Budget demotion", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create("budget_demotion");
		store = new Repository(tdb.db);
		await store.loadSchemes(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("demote_turn_entries SQL", () => {
		it("demotes promoted entries to fidelity=demoted without changing status", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_1" });

			await store.set({
				runId,
				turn: 3,
				path: "known://fact-a",
				body: "fact content",
				state: "resolved",
				fidelity: "promoted",
			});
			await store.set({
				runId,
				turn: 3,
				path: "known://fact-b",
				body: "more facts",
				state: "resolved",
				fidelity: "promoted",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 3 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const a = entries.find((e) => e.path === "known://fact-a");
			const b = entries.find((e) => e.path === "known://fact-b");

			assert.strictEqual(a.fidelity, "demoted", "fact-a demoted");
			assert.strictEqual(a.state, "resolved", "fact-a status preserved at 200");
			assert.strictEqual(b.fidelity, "demoted", "fact-b demoted");
			assert.strictEqual(b.state, "resolved", "fact-b status preserved at 200");
		});

		it("demotes logging entries at the same turn, status preserved", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_log" });

			await store.set({
				runId,
				turn: 5,
				path: "get://turn_5/file.js",
				body: "file body",
				state: "resolved",
				fidelity: "promoted",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 5 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "get://turn_5/file.js");
			assert.strictEqual(entry.fidelity, "demoted", "logging entry demoted");
			assert.strictEqual(entry.state, "resolved", "status preserved");
		});

		it("does not demote entries from other turns", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_2" });

			await store.set({
				runId,
				turn: 2,
				path: "known://turn2-fact",
				body: "earlier fact",
				state: "resolved",
				fidelity: "promoted",
			});
			await store.set({
				runId,
				turn: 4,
				path: "known://turn4-fact",
				body: "later fact",
				state: "resolved",
				fidelity: "promoted",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 3 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const t2 = entries.find((e) => e.path === "known://turn2-fact");
			const t4 = entries.find((e) => e.path === "known://turn4-fact");
			assert.strictEqual(t2.fidelity, "promoted", "turn 2 entry untouched");
			assert.strictEqual(t4.fidelity, "promoted", "turn 4 entry untouched");
		});

		it("does not demote entries already in error state", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_3" });

			await store.set({
				runId,
				turn: 6,
				path: "known://errored",
				body: "body",
				state: "failed",
				fidelity: "promoted",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 6 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "known://errored");
			assert.strictEqual(entry.fidelity, "promoted", "4xx entry not demoted");
		});

		it("demotes budget entries too (onView renders full at summary)", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_budget" });

			await store.set({
				runId,
				turn: 7,
				path: "budget://1/7",
				body: "413 report",
				state: "resolved",
				fidelity: "promoted",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 7 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "budget://1/7");
			assert.strictEqual(entry.fidelity, "demoted", "budget entry demoted");
		});
	});
});
