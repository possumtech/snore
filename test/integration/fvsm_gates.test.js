/**
 * FVSM phase advancement gates.
 *
 * Covers @fvsm_state_machine — the four-rule contract that gates
 * phase transitions. Each rule is a check against the current run's
 * entry state at the moment a status emission claims advancement:
 *
 *   145 (Decomposition → Distillation) — needs `unknown://**` ≥ 1
 *   156 (Distillation → Demotion)      — needs `known://**` ≥ 1
 *   167 (Demotion → Delivery)          — needs visible `unknown://**` = 0
 *   200 (Delivery final)               — currentPhase must equal 7
 *
 * Plus the routing rule: nextPhase > currentPhase + 1 is illegal
 * (no skipping). Rejected advances do NOT write phase-history; the
 * test verifies the gate's verdict, not the side effects (those are
 * exercised by the update plugin's tests).
 */
import assert from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("FVSM phase gates (@fvsm_state_machine)", () => {
	let tdb, store, RUN_ID;

	before(async () => {
		tdb = await TestDb.create("fvsm_gates");
		store = new Entries(tdb.db);
		const seed = await tdb.seedRun({ alias: "fvsm_1" });
		RUN_ID = seed.runId;
	});

	beforeEach(async () => {
		await store.rm({ runId: RUN_ID, path: "**", pattern: true });
	});

	after(async () => {
		await tdb.cleanup();
	});

	// Build the rummy bag validateNavigation expects. `sequence` is
	// the current turn — getCurrentPhase only counts updates from
	// turns BEFORE sequence, so this controls "history vs. now".
	function rummyBag(sequence) {
		return { runId: RUN_ID, sequence, entries: store };
	}

	async function seedPhaseHistory(turn, status) {
		await store.set({
			runId: RUN_ID,
			turn,
			path: `log://turn_${turn}/update/seeded`,
			body: "seeded phase history",
			attributes: { status },
			state: "resolved",
		});
	}

	async function seedUnknown(slug, { turn = 1, visibility = "visible" } = {}) {
		await store.set({
			runId: RUN_ID,
			turn,
			path: `unknown://${slug}`,
			body: "x",
			state: "resolved",
			visibility,
		});
	}

	async function seedKnown(slug, { turn = 1 } = {}) {
		await store.set({
			runId: RUN_ID,
			turn,
			path: `known://${slug}`,
			body: "x",
			state: "resolved",
		});
	}

	describe("145 gate: Decomposition → Distillation requires unknowns written THIS TURN", () => {
		it("rejects when zero unknowns exist", async () => {
			const result = await tdb.hooks.instructions.validateNavigation(
				145,
				rummyBag(2),
			);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "YOU MUST identify unknowns in current mode");
		});

		it("accepts when an unknown is written THIS TURN", async () => {
			await seedUnknown("a", { turn: 2 });
			const result = await tdb.hooks.instructions.validateNavigation(
				145,
				rummyBag(2),
			);
			assert.equal(result.ok, true);
		});

		it("rejects when only stale unknowns from prior turns exist (current-turn gate, not run-aggregate)", async () => {
			// The gate must distinguish "this turn did the decomposition work"
			// from "any unknown ever existed in this run." A model that emits
			// 145 on turn 5 with only a turn-1 leftover unknown has done no
			// decomposition this turn — the gate must reject.
			await seedUnknown("from_turn_1", { turn: 1 });
			const result = await tdb.hooks.instructions.validateNavigation(
				145,
				rummyBag(5),
			);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "YOU MUST identify unknowns in current mode");
		});
	});

	describe("156 gate: Distillation → Demotion requires knowns written THIS TURN", () => {
		it("rejects when zero knowns exist (after a successful 145)", async () => {
			await seedPhaseHistory(1, 145);
			await seedUnknown("a");
			const result = await tdb.hooks.instructions.validateNavigation(
				156,
				rummyBag(2),
			);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "YOU MUST identify knowns in current mode");
		});

		it("accepts when a known is written THIS TURN", async () => {
			await seedPhaseHistory(1, 145);
			await seedUnknown("a");
			await seedKnown("k", { turn: 2 });
			const result = await tdb.hooks.instructions.validateNavigation(
				156,
				rummyBag(2),
			);
			assert.equal(result.ok, true);
		});

		it("rejects when only stale knowns from prior turns exist (current-turn gate, not run-aggregate)", async () => {
			// Same shape as 145: a model emitting 156 on turn 5 with a
			// turn-2 leftover known has done no distillation this turn.
			await seedPhaseHistory(1, 145);
			await seedPhaseHistory(2, 155);
			await seedUnknown("a", { turn: 1 });
			await seedKnown("from_turn_2", { turn: 2 });
			const result = await tdb.hooks.instructions.validateNavigation(
				156,
				rummyBag(5),
			);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "YOU MUST identify knowns in current mode");
		});
	});

	describe("167 gate: Demotion → Delivery requires zero VISIBLE unknowns", () => {
		it("rejects when at least one unknown is still visible", async () => {
			await seedPhaseHistory(1, 145);
			await seedPhaseHistory(2, 156);
			await seedUnknown("a"); // visible by default
			await seedKnown("k");
			const result = await tdb.hooks.instructions.validateNavigation(
				167,
				rummyBag(3),
			);
			assert.equal(result.ok, false);
			assert.equal(
				result.reason,
				"YOU MUST demote all unknowns before Delivery",
			);
		});

		it("accepts when every unknown is summarized", async () => {
			await seedPhaseHistory(1, 145);
			await seedPhaseHistory(2, 156);
			await seedUnknown("a", { visibility: "summarized" });
			await seedKnown("k");
			const result = await tdb.hooks.instructions.validateNavigation(
				167,
				rummyBag(3),
			);
			assert.equal(result.ok, true);
		});
	});

	describe("200 (Delivery final): only valid when currentPhase = 7", () => {
		it("rejects 200 from phase 4", async () => {
			const result = await tdb.hooks.instructions.validateNavigation(
				200,
				rummyBag(2),
			);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "Illegal navigation attempt");
		});

		it("accepts 200 from phase 7", async () => {
			await seedPhaseHistory(1, 145);
			await seedPhaseHistory(2, 156);
			await seedPhaseHistory(3, 167);
			const result = await tdb.hooks.instructions.validateNavigation(
				200,
				rummyBag(4),
			);
			assert.equal(result.ok, true);
		});
	});

	describe("Routing rule: nextPhase > currentPhase + 1 is illegal", () => {
		it("rejects 167 attempted from phase 4 (skip-ahead)", async () => {
			const result = await tdb.hooks.instructions.validateNavigation(
				167,
				rummyBag(2),
			);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "Illegal navigation attempt");
		});

		it("rejects 156 attempted from phase 4 (skip-ahead)", async () => {
			const result = await tdb.hooks.instructions.validateNavigation(
				156,
				rummyBag(2),
			);
			assert.equal(result.ok, false);
			assert.equal(result.reason, "Illegal navigation attempt");
		});
	});
});
