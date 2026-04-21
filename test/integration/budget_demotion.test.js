/**
 * Budget demotion integration tests.
 *
 * Covers:
 * - demote_turn_entries: all promoted entries at turn N → visibility=demoted.
 *   Status is preserved: a successful operation stays at its original
 *   status (200), because budget demotion is a lifecycle event, not a
 *   failure of the body operation. The budget:// entry is the canonical
 *   record of the panic event.
 * - Error-state entries are not re-demoted
 * - Other turns are not affected
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("Budget demotion", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create("budget_demotion");
		store = new Entries(tdb.db);
		await store.loadSchemes(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("demote_turn_entries SQL", () => {
		it("demotes promoted entries to visibility=demoted without changing status", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_1" });

			await store.set({
				runId,
				turn: 3,
				path: "known://fact-a",
				body: "fact content",
				state: "resolved",
				visibility: "visible",
			});
			await store.set({
				runId,
				turn: 3,
				path: "known://fact-b",
				body: "more facts",
				state: "resolved",
				visibility: "visible",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 3 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const a = entries.find((e) => e.path === "known://fact-a");
			const b = entries.find((e) => e.path === "known://fact-b");

			assert.strictEqual(a.visibility, "summarized", "fact-a demoted");
			assert.strictEqual(a.state, "resolved", "fact-a status preserved at 200");
			assert.strictEqual(b.visibility, "summarized", "fact-b demoted");
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
				visibility: "visible",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 5 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "get://turn_5/file.js");
			assert.strictEqual(entry.visibility, "summarized", "logging entry demoted");
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
				visibility: "visible",
			});
			await store.set({
				runId,
				turn: 4,
				path: "known://turn4-fact",
				body: "later fact",
				state: "resolved",
				visibility: "visible",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 3 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const t2 = entries.find((e) => e.path === "known://turn2-fact");
			const t4 = entries.find((e) => e.path === "known://turn4-fact");
			assert.strictEqual(t2.visibility, "visible", "turn 2 entry untouched");
			assert.strictEqual(t4.visibility, "visible", "turn 4 entry untouched");
		});

		it("does not demote entries already in error state", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_3" });

			await store.set({
				runId,
				turn: 6,
				path: "known://errored",
				body: "body",
				state: "failed",
				visibility: "visible",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 6 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "known://errored");
			assert.strictEqual(entry.visibility, "visible", "4xx entry not demoted");
		});

		it("demotes budget entries too (onView renders full at summary)", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_budget" });

			await store.set({
				runId,
				turn: 7,
				path: "budget://1/7",
				body: "413 report",
				state: "resolved",
				visibility: "visible",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 7 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "budget://1/7");
			assert.strictEqual(entry.visibility, "summarized", "budget entry demoted");
		});
	});
});
