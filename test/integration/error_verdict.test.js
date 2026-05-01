/**
 * Error verdict and cycle detection.
 *
 * Covers @response_healing, @loops_table, @error_plugin — the
 * strike streak +
 * cycle detection that live in the error plugin's verdict, which
 * operates over loops (strike state is per-loop). This is the
 * behavior that decides "continue" vs "run abandoned with 499"
 * after each turn. If it breaks, runs either never terminate or
 * terminate on the first noise.
 */
import assert from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

const MAX_STRIKES = Number(process.env.RUMMY_MAX_STRIKES);
const MIN_CYCLES = Number(process.env.RUMMY_MIN_CYCLES);

describe("error verdict (@response_healing)", () => {
	let tdb;
	let store;
	let RUN_ID;
	let LOOP_ID;

	before(async () => {
		tdb = await TestDb.create("error_verdict");
		store = new Entries(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	async function newLoop(turn = 1) {
		const alias = `verdict_${Date.now()}_${Math.random()
			.toString(36)
			.slice(2, 6)}`;
		const { runId } = await tdb.seedRun({ alias });
		RUN_ID = runId;
		const loop = await tdb.db.enqueue_loop.get({
			run_id: runId,
			sequence: 1,
			mode: "act",
			model: null,
			prompt: "test",
			config: null,
		});
		LOOP_ID = loop.id;
		await tdb.hooks.loop.started.emit({ runId, loopId: LOOP_ID });
		await bumpTurn(turn);
	}

	async function bumpTurn(turn) {
		await tdb.hooks.turn.started.emit({
			rummy: {
				entries: store,
				runId: RUN_ID,
				sequence: turn,
				loopId: LOOP_ID,
				toolSet: null,
			},
		});
	}

	// Each test runs against a fresh loop so strike counters don't leak.
	beforeEach(async () => {
		await newLoop(1);
	});

	function fakeGet(path) {
		return { scheme: "get", path, attributes: { path } };
	}

	it("clean turn with terminal summary → continue=false, status=200", async () => {
		const verdict = await tdb.hooks.error.verdict({
			store,
			runId: RUN_ID,
			loopId: LOOP_ID,
			turn: 1,
			recorded: [fakeGet("src/a.js")],
			summaryText: "done",
		});
		assert.strictEqual(verdict.continue, false);
		assert.strictEqual(verdict.status, 200);
	});

	it("no summary, no errors → continue=true", async () => {
		const verdict = await tdb.hooks.error.verdict({
			store,
			runId: RUN_ID,
			loopId: LOOP_ID,
			turn: 1,
			recorded: [fakeGet("src/a.js")],
			summaryText: null,
		});
		assert.strictEqual(verdict.continue, true);
	});

	it("an error this turn blocks status=200 even with summary", async () => {
		await tdb.hooks.error.log.emit({
			store,
			runId: RUN_ID,
			turn: 1,
			loopId: LOOP_ID,
			message: "pretend something failed",
			status: 500,
		});
		const verdict = await tdb.hooks.error.verdict({
			store,
			runId: RUN_ID,
			loopId: LOOP_ID,
			turn: 1,
			recorded: [fakeGet("src/a.js")],
			summaryText: "done",
		});
		assert.strictEqual(
			verdict.continue,
			true,
			"summary + error → not actually done",
		);
		assert.notStrictEqual(verdict.status, 200);
	});

	it(`abandoning strike (#${MAX_STRIKES}) with same-turn summary → completion, not 499`, async () => {
		// First MAX_STRIKES-1 strikes: model errors with no summary, gets retried.
		for (let i = 0; i < MAX_STRIKES - 1; i++) {
			await tdb.hooks.error.log.emit({
				store,
				runId: RUN_ID,
				turn: i + 1,
				loopId: LOOP_ID,
				message: `strike ${i + 1}`,
				status: 422,
			});
			await tdb.hooks.error.verdict({
				store,
				runId: RUN_ID,
				loopId: LOOP_ID,
				turn: i + 1,
				recorded: [fakeGet(`src/${i}.js`)],
				summaryText: null,
			});
			await bumpTurn(i + 2);
		}
		// Final strike turn — model also emits a terminal update.
		await tdb.hooks.error.log.emit({
			store,
			runId: RUN_ID,
			turn: MAX_STRIKES,
			loopId: LOOP_ID,
			message: "strike that coincides with delivery",
			status: 413,
		});
		const verdict = await tdb.hooks.error.verdict({
			store,
			runId: RUN_ID,
			loopId: LOOP_ID,
			turn: MAX_STRIKES,
			recorded: [fakeGet("src/final.js")],
			summaryText: "delivered the report",
		});
		assert.strictEqual(verdict.continue, false);
		assert.strictEqual(
			verdict.status,
			200,
			"terminal-strike turn with summary completes at 200, not 499",
		);
	});

	it(`${MAX_STRIKES} consecutive erroring turns → continue=false, status=499`, async () => {
		let verdict;
		for (let i = 0; i < MAX_STRIKES; i++) {
			await tdb.hooks.error.log.emit({
				store,
				runId: RUN_ID,
				turn: i + 1,
				loopId: LOOP_ID,
				message: `strike ${i + 1}`,
				status: 422,
			});
			verdict = await tdb.hooks.error.verdict({
				store,
				runId: RUN_ID,
				loopId: LOOP_ID,
				turn: i + 1,
				recorded: [fakeGet(`src/${i}.js`)],
				summaryText: null,
			});
			// Reset turnErrors for next simulated turn
			await bumpTurn(i + 2);
		}
		assert.strictEqual(
			verdict.continue,
			false,
			`struck out after ${MAX_STRIKES}`,
		);
		assert.strictEqual(verdict.status, 499);
	});

	it("clean turn resets the strike streak", async () => {
		// Two erroring turns
		for (let i = 0; i < 2; i++) {
			await tdb.hooks.error.log.emit({
				store,
				runId: RUN_ID,
				turn: i + 1,
				loopId: LOOP_ID,
				message: `err ${i}`,
				status: 500,
			});
			await tdb.hooks.error.verdict({
				store,
				runId: RUN_ID,
				loopId: LOOP_ID,
				turn: i + 1,
				recorded: [fakeGet(`src/${i}.js`)],
				summaryText: null,
			});
			await bumpTurn(i + 2);
		}
		// Clean turn
		await tdb.hooks.error.verdict({
			store,
			runId: RUN_ID,
			loopId: LOOP_ID,
			turn: 3,
			recorded: [fakeGet("src/clean.js")],
			summaryText: null,
		});
		await bumpTurn(3);
		// One more erroring turn: if streak reset, this is strike=1, not strike=3.
		await tdb.hooks.error.log.emit({
			store,
			runId: RUN_ID,
			turn: 4,
			loopId: LOOP_ID,
			message: "solo err",
			status: 500,
		});
		const v = await tdb.hooks.error.verdict({
			store,
			runId: RUN_ID,
			loopId: LOOP_ID,
			turn: 4,
			recorded: [fakeGet("src/d.js")],
			summaryText: null,
		});
		assert.strictEqual(
			v.continue,
			true,
			"streak reset after clean turn; not at 3 strikes",
		);
	});

	it(`cycle detection silently strikes — no model-facing error entry`, async () => {
		// MIN_CYCLES identical fingerprints trips detection. The watchdog
		// must not surface a "Loop detected" entry to the model — strikes
		// silently and lets MAX_STRIKES abandon. Telling the model invites
		// superficial evasion (vary an attribute to bust the fingerprint).
		const recorded = [fakeGet("src/loop.js")];
		for (let i = 0; i < MIN_CYCLES; i++) {
			const verdict = await tdb.hooks.error.verdict({
				store,
				runId: RUN_ID,
				loopId: LOOP_ID,
				turn: i + 1,
				recorded,
				summaryText: null,
			});
			assert.strictEqual(
				verdict.continue,
				true,
				`turn ${i + 1}: still under MAX_STRIKES, continue`,
			);
			assert.notStrictEqual(
				verdict.reason,
				"Loop detected",
				"verdict reason must not leak the watchdog mechanism",
			);
			await bumpTurn(i + 2);
		}
		const errors = await store.getEntriesByPattern(RUN_ID, "log://**", null);
		const cycleError = errors.find(
			(e) => e.path.includes("/error/") && e.body === "Loop detected",
		);
		assert.strictEqual(
			cycleError,
			undefined,
			"no model-facing 'Loop detected' entry — watchdog stays silent",
		);
	});

	it(`cycle drives 499 abandonment after MAX_STRIKES detections`, async () => {
		// MIN_CYCLES identical turns trip cycle detection (silent strike #1).
		// Each subsequent identical turn keeps tripping; once the silent
		// strike streak reaches MAX_STRIKES, the run abandons at 499.
		const recorded = [fakeGet("src/loop.js")];
		const total = MIN_CYCLES + MAX_STRIKES - 1;
		let verdict;
		for (let i = 0; i < total; i++) {
			verdict = await tdb.hooks.error.verdict({
				store,
				runId: RUN_ID,
				loopId: LOOP_ID,
				turn: i + 1,
				recorded,
				summaryText: null,
			});
			await bumpTurn(i + 2);
		}
		assert.strictEqual(
			verdict.continue,
			false,
			"abandons after sustained loop",
		);
		assert.strictEqual(verdict.status, 499);
		assert.strictEqual(
			verdict.reason,
			"Loop detected",
			"abandonment reason is telemetry-only (run is over; model never sees it)",
		);
	});

	it("action entry state=failed counts as a strike (no error.log.emit needed)", async () => {
		// "validation" is a hard outcome (not in SOFT_FAILURE_OUTCOMES);
		// soft outcomes like "not_found" / "conflict" are findings the
		// model adapts to, not contract violations, and don't strike.
		const path = "log://turn_1/set/bad_path";
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path,
			body: "target invalid",
			state: "failed",
			outcome: "validation",
			loopId: LOOP_ID,
		});
		const verdict = await tdb.hooks.error.verdict({
			store,
			runId: RUN_ID,
			loopId: LOOP_ID,
			turn: 1,
			recorded: [{ scheme: "get", path, attributes: { path: "X" } }],
			summaryText: null,
		});
		assert.strictEqual(
			verdict.continue,
			true,
			"struck but under MAX_STRIKES → continue with reminder",
		);
		assert.ok(verdict.reason, "struck turns carry the contract reminder");
	});

	it("reasoning-runaway: ContextExceeded errors accumulate strikes → 499", async () => {
		// Simulates the model returning ever-larger reasoning blocks until
		// the prompt exceeds the context window. TurnExecutor catches
		// ContextExceededError and emits error.log at status 413; strikes
		// accumulate via turnErrors. After MAX_STRIKES of these, the run
		// abandons cleanly at 499. Verifies the watchdog story.
		let verdict;
		for (let i = 0; i < MAX_STRIKES; i++) {
			await tdb.hooks.error.log.emit({
				store,
				runId: RUN_ID,
				turn: i + 1,
				loopId: LOOP_ID,
				message: `LLM context exceeded: prompt grew past window`,
				status: 413,
			});
			verdict = await tdb.hooks.error.verdict({
				store,
				runId: RUN_ID,
				loopId: LOOP_ID,
				turn: i + 1,
				recorded: [],
				summaryText: null,
			});
			await bumpTurn(i + 2);
		}
		assert.strictEqual(verdict.continue, false);
		assert.strictEqual(verdict.status, 499);
	});

	it(`${MAX_STRIKES} action-entry failures abandon the run at 499`, async () => {
		// Hard outcomes (e.g. "validation") strike each turn; soft
		// outcomes ("not_found" / "conflict") don't accumulate strikes
		// because they're recoverable findings, not contract violations.
		let verdict;
		for (let i = 0; i < MAX_STRIKES; i++) {
			const path = `log://turn_${i + 1}/set/bad_${i}`;
			await store.set({
				runId: RUN_ID,
				turn: i + 1,
				path,
				body: `bad payload ${i}`,
				state: "failed",
				outcome: "validation",
				loopId: LOOP_ID,
			});
			verdict = await tdb.hooks.error.verdict({
				store,
				runId: RUN_ID,
				loopId: LOOP_ID,
				turn: i + 1,
				recorded: [{ scheme: "set", path, attributes: { path: `X${i}` } }],
				summaryText: null,
			});
			await bumpTurn(i + 2);
		}
		assert.strictEqual(verdict.continue, false);
		assert.strictEqual(verdict.status, 499);
	});
});
