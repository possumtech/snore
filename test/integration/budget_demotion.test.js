/**
 * Budget demotion integration tests.
 *
 * Covers @budget_enforcement — specifically the post-dispatch
 * `demote_turn_entries` SQL that flips all visible turn entries to
 * `visibility=summarized` when the ceiling is breached. Status is
 * preserved: a successful operation stays at its original status
 * (200), because budget demotion is a lifecycle event, not a failure
 * of the body operation.
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
			assert.strictEqual(
				entry.visibility,
				"summarized",
				"logging entry demoted",
			);
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
	});

	describe("demoteRunVisibleEntries — cross-turn fallback (@budget_enforcement)", () => {
		// Observed in rummy_dev.db::test:demo: promotions from turns 12–14
		// stayed visible through turns 15–17 because the model never
		// demoted them and `demote_turn_entries(turn)` is scoped to the
		// current turn. The base context drifted over ceiling, each
		// subsequent turn's postDispatch found 0 this-turn promotions to
		// demote, and the error plugin struck out the run.
		//
		// The fallback demotes all currently-visible entries across the
		// run when this-turn demotion yields nothing. That keeps the loop
		// alive the same way auto-demotion does for single-turn overshoots.
		it("demotes visible entries from prior turns and returns their paths+turns", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_cross" });

			await store.set({
				runId,
				turn: 12,
				path: "https://example.com/old",
				body: "old page content",
				state: "resolved",
				visibility: "visible",
			});
			await store.set({
				runId,
				turn: 14,
				path: "https://example.com/newer",
				body: "newer page content",
				state: "resolved",
				visibility: "visible",
			});

			const demoted = await store.demoteRunVisibleEntries(runId);
			const paths = demoted.map((d) => d.path);
			assert.ok(
				paths.includes("https://example.com/old"),
				"turn 12 visible entry demoted by fallback",
			);
			assert.ok(
				paths.includes("https://example.com/newer"),
				"turn 14 visible entry demoted by fallback",
			);
			// Turn ordering: oldest promotion first.
			const oldIdx = demoted.findIndex(
				(d) => d.path === "https://example.com/old",
			);
			const newIdx = demoted.findIndex(
				(d) => d.path === "https://example.com/newer",
			);
			assert.ok(oldIdx < newIdx, "oldest turn listed first");
			// Each result carries turn + tokens so the error body can show them.
			for (const d of demoted) {
				assert.ok(typeof d.turn === "number", "turn returned");
				assert.ok(typeof d.tokens === "number", "tokens returned");
			}

			// DB state: both now summarized.
			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			assert.strictEqual(
				entries.find((e) => e.path === "https://example.com/old").visibility,
				"summarized",
			);
			assert.strictEqual(
				entries.find((e) => e.path === "https://example.com/newer").visibility,
				"summarized",
			);
		});

		it("skips failed/cancelled entries (already not contributing)", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_cross_skip" });

			await store.set({
				runId,
				turn: 3,
				path: "https://example.com/ok",
				body: "kept",
				state: "resolved",
				visibility: "visible",
			});
			await store.set({
				runId,
				turn: 3,
				path: "https://example.com/bad",
				body: "failed",
				state: "failed",
				visibility: "visible",
			});

			const demoted = await store.demoteRunVisibleEntries(runId);
			const paths = demoted.map((d) => d.path);
			assert.ok(paths.includes("https://example.com/ok"));
			assert.ok(!paths.includes("https://example.com/bad"), "failed skipped");
		});
	});
});
