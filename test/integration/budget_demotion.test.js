/**
 * Budget demotion integration tests.
 *
 * Covers:
 * - demotePreviousLoopLogging: full logging entries from other loops → summary
 * - demote_turn_data_entries: full data entries at turn N → summary + 413
 * - Current-loop logging entries are NOT demoted
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

	describe("demotePreviousLoopLogging", () => {
		it("demotes full logging entries from other loops to summary", async () => {
			const { runId } = await tdb.seedRun({ alias: "dpl_1" });

			// Seed loop 1 and loop 2 in DB
			await tdb.db.enqueue_loop.get({
				run_id: runId,
				sequence: 1,
				mode: "ask",
				model: "m",
				prompt: "p1",
				config: "{}",
			});
			const loop1 = await tdb.db.claim_next_loop.get({ run_id: runId });
			await tdb.db.complete_loop.run({
				id: loop1.id,
				status: 200,
				result: null,
			});
			await tdb.db.enqueue_loop.get({
				run_id: runId,
				sequence: 2,
				mode: "ask",
				model: "m",
				prompt: "p2",
				config: "{}",
			});
			const loop2 = await tdb.db.claim_next_loop.get({ run_id: runId });

			// Write a full logging entry attributed to loop 1
			await store.upsert(
				runId,
				1,
				"get://turn_1/file.js",
				"big content here",
				200,
				{
					fidelity: "full",
					loopId: loop1.id,
				},
			);

			// Demote from loop 2's perspective
			await store.demotePreviousLoopLogging(runId, loop2.id);

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "get://turn_1/file.js");
			assert.strictEqual(
				entry.fidelity,
				"summary",
				"logging entry from loop 1 demoted",
			);
		});

		it("leaves current-loop logging entries at full fidelity", async () => {
			const { runId } = await tdb.seedRun({ alias: "dpl_2" });

			await tdb.db.enqueue_loop.get({
				run_id: runId,
				sequence: 1,
				mode: "ask",
				model: "m",
				prompt: "p",
				config: "{}",
			});
			const loop = await tdb.db.claim_next_loop.get({ run_id: runId });

			await store.upsert(runId, 1, "get://turn_1/current.js", "content", 200, {
				fidelity: "full",
				loopId: loop.id,
			});

			// Demote — but use the SAME loop id
			await store.demotePreviousLoopLogging(runId, loop.id);

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "get://turn_1/current.js");
			assert.strictEqual(
				entry.fidelity,
				"full",
				"current-loop entry untouched",
			);
		});

		it("leaves non-logging entries untouched", async () => {
			const { runId } = await tdb.seedRun({ alias: "dpl_3" });

			await tdb.db.enqueue_loop.get({
				run_id: runId,
				sequence: 1,
				mode: "ask",
				model: "m",
				prompt: "p",
				config: "{}",
			});
			const loop1 = await tdb.db.claim_next_loop.get({ run_id: runId });
			await tdb.db.complete_loop.run({
				id: loop1.id,
				status: 200,
				result: null,
			});
			await tdb.db.enqueue_loop.get({
				run_id: runId,
				sequence: 2,
				mode: "ask",
				model: "m",
				prompt: "p2",
				config: "{}",
			});
			const loop2 = await tdb.db.claim_next_loop.get({ run_id: runId });

			// Data entry — category = 'data', not 'logging'
			await store.upsert(runId, 1, "known://my-fact", "a fact", 200, {
				fidelity: "full",
				loopId: loop1.id,
			});

			await store.demotePreviousLoopLogging(runId, loop2.id);

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "known://my-fact");
			assert.strictEqual(entry.fidelity, "full", "data entry not demoted");
		});
	});

	describe("demote_turn_data_entries SQL", () => {
		it("demotes full data entries at turn N to summary with status 413", async () => {
			const { runId } = await tdb.seedRun({ alias: "dtde_1" });

			// 'known' scheme is category='data'
			await store.upsert(runId, 3, "known://fact-a", "fact content", 200, {
				fidelity: "full",
			});
			await store.upsert(runId, 3, "known://fact-b", "more facts", 200, {
				fidelity: "full",
			});

			await tdb.db.demote_turn_data_entries.run({ run_id: runId, turn: 3 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const a = entries.find((e) => e.path === "known://fact-a");
			const b = entries.find((e) => e.path === "known://fact-b");

			assert.strictEqual(a.fidelity, "summary", "fact-a demoted to summary");
			assert.strictEqual(a.status, 413, "fact-a status set to 413");
			assert.strictEqual(b.fidelity, "summary", "fact-b demoted to summary");
			assert.strictEqual(b.status, 413, "fact-b status set to 413");
		});

		it("does not demote data entries from other turns", async () => {
			const { runId } = await tdb.seedRun({ alias: "dtde_2" });

			await store.upsert(runId, 2, "known://turn2-fact", "earlier fact", 200, {
				fidelity: "full",
			});
			await store.upsert(runId, 4, "known://turn4-fact", "later fact", 200, {
				fidelity: "full",
			});

			await tdb.db.demote_turn_data_entries.run({ run_id: runId, turn: 3 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const t2 = entries.find((e) => e.path === "known://turn2-fact");
			const t4 = entries.find((e) => e.path === "known://turn4-fact");
			assert.strictEqual(t2.fidelity, "full", "turn 2 entry untouched");
			assert.strictEqual(t4.fidelity, "full", "turn 4 entry untouched");
		});

		it("does not demote logging entries at the same turn", async () => {
			const { runId } = await tdb.seedRun({ alias: "dtde_3" });

			// 'get' scheme is category='logging'
			await store.upsert(runId, 5, "get://turn_5/file.js", "file body", 200, {
				fidelity: "full",
			});

			await tdb.db.demote_turn_data_entries.run({ run_id: runId, turn: 5 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "get://turn_5/file.js");
			assert.strictEqual(entry.fidelity, "full", "logging entry not demoted");
		});

		it("does not demote entries already in error state", async () => {
			const { runId } = await tdb.seedRun({ alias: "dtde_4" });

			await store.upsert(runId, 6, "known://errored", "body", 400, {
				fidelity: "full",
			});

			await tdb.db.demote_turn_data_entries.run({ run_id: runId, turn: 6 });

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "known://errored");
			assert.strictEqual(entry.fidelity, "full", "4xx entry not demoted");
		});
	});
});
