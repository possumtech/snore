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
				path: "https://example.com/page-a",
				body: "page-a content",
				state: "resolved",
				visibility: "visible",
			});
			await store.set({
				runId,
				turn: 3,
				path: "https://example.com/page-b",
				body: "page-b content",
				state: "resolved",
				visibility: "visible",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 3 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const a = entries.find((e) => e.path === "https://example.com/page-a");
			const b = entries.find((e) => e.path === "https://example.com/page-b");

			assert.strictEqual(a.visibility, "summarized", "page-a demoted");
			assert.strictEqual(a.state, "resolved", "page-a status preserved at 200");
			assert.strictEqual(b.visibility, "summarized", "page-b demoted");
			assert.strictEqual(b.state, "resolved", "page-b status preserved at 200");
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
				path: "https://example.com/turn2",
				body: "earlier page",
				state: "resolved",
				visibility: "visible",
			});
			await store.set({
				runId,
				turn: 4,
				path: "https://example.com/turn4",
				body: "later page",
				state: "resolved",
				visibility: "visible",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 3 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const t2 = entries.find((e) => e.path === "https://example.com/turn2");
			const t4 = entries.find((e) => e.path === "https://example.com/turn4");
			assert.strictEqual(t2.visibility, "visible", "turn 2 entry untouched");
			assert.strictEqual(t4.visibility, "visible", "turn 4 entry untouched");
		});

		it("does not demote entries already in error state", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_3" });

			await store.set({
				runId,
				turn: 6,
				path: "https://example.com/errored",
				body: "body",
				state: "failed",
				visibility: "visible",
			});

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 6 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find(
				(e) => e.path === "https://example.com/errored",
			);
			assert.strictEqual(entry.visibility, "visible", "4xx entry not demoted");
		});

		// Regression — observed in rummy_dev.db::test:demo turn 7. The model
		// emitted the documented Distill+Demote pattern (created two knowns,
		// demoted the source URL) and overflowed by ~4k tokens. Post-dispatch
		// `demote_turn_entries` indiscriminately summarized everything from
		// that turn — including the just-created knowns. End-of-run the model
		// could not see its own deliverables and re-derived the same content
		// at a parallel path. Knowns and unknowns are deliverables, never
		// housekeeping; the budget enforcer must skip them.
		it("does not demote known:// or unknown:// entries (deliverables)", async () => {
			const { runId } = await tdb.seedRun({ alias: "dte_protected" });

			await store.set({
				runId,
				turn: 7,
				path: "known://geography/lost_river",
				body: "Lost River flows underground through karst conduits.",
				state: "resolved",
				visibility: "visible",
			});
			await store.set({
				runId,
				turn: 7,
				path: "unknown://geography/aquifers",
				body: "Aquifer composition under Orange County",
				state: "resolved",
				visibility: "visible",
			});
			await store.set({
				runId,
				turn: 7,
				path: "https://example.com/source",
				body: "source URL the model fetched and is done with",
				state: "resolved",
				visibility: "visible",
			});

			const targets = await tdb.db.get_turn_demotion_targets.all({
				run_id: runId,
				turn: 7,
			});
			const targetPaths = targets.map((t) => t.path);
			assert.ok(
				targetPaths.includes("https://example.com/source"),
				"source URL is a demotion target",
			);
			assert.ok(
				!targetPaths.includes("known://geography/lost_river"),
				"known:// entry not in demotion target list",
			);
			assert.ok(
				!targetPaths.includes("unknown://geography/aquifers"),
				"unknown:// entry not in demotion target list",
			);

			await tdb.db.demote_turn_entries.run({ run_id: runId, turn: 7 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const known = entries.find(
				(e) => e.path === "known://geography/lost_river",
			);
			const unknown = entries.find(
				(e) => e.path === "unknown://geography/aquifers",
			);
			const source = entries.find(
				(e) => e.path === "https://example.com/source",
			);
			assert.strictEqual(
				known.visibility,
				"visible",
				"known:// survived budget demotion",
			);
			assert.strictEqual(
				unknown.visibility,
				"visible",
				"unknown:// survived budget demotion",
			);
			assert.strictEqual(
				source.visibility,
				"summarized",
				"source URL was demoted as expected",
			);
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
