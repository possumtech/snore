import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import ErrorPlugin from "./error.js";

const MAX_STRIKES = Number(process.env.RUMMY_MAX_STRIKES);
const MIN_CYCLES = Number(process.env.RUMMY_MIN_CYCLES);

function makeCore() {
	const hooks = createHooks();
	const core = new PluginContext("error", hooks);
	new ErrorPlugin(core);
	return { hooks, core };
}

function makeStore({ stateByPath = new Map(), updates = [] } = {}) {
	const calls = [];
	return {
		_calls: calls,
		async logPath(_runId, turn, kind, message) {
			return `log://turn_${turn}/${kind}/${encodeURIComponent(message)}`;
		},
		async set(args) {
			calls.push(args);
		},
		async getState(_runId, path) {
			return stateByPath.get(path) ?? null;
		},
		async getEntriesByPattern(_runId, pattern) {
			if (pattern === "log://*/update/**") return updates;
			return [];
		},
	};
}

async function startLoop(hooks, loopId) {
	await hooks.loop.started.emit({ loopId });
}

async function startTurn(hooks, loopId, sequence = 1, opts = {}) {
	await hooks.turn.started.emit({
		rummy: {
			loopId,
			sequence,
			runId: "r",
			entries: opts.entries || makeStore(),
			hooks,
		},
	});
}

// Fire a verdict carrying a single recorded update at the given status —
// what the model emitted on this turn. Stagnation pressure now lives in
// verdict and reads phase from this entry, not from prior-turn DB scans.
async function runVerdict(hooks, store, loopId, turn, status) {
	const recorded =
		status == null
			? []
			: [
					{
						scheme: "update",
						path: `log://turn_${turn}/update/x`,
						attributes: { status },
					},
				];
	return hooks.turn.verdict.filter(
		{ continue: true },
		{ store, runId: "r", loopId, turn, recorded, summaryText: null },
	);
}

describe("error plugin: views", () => {
	it("visible projection labels body with `# error` header", async () => {
		const { hooks } = makeCore();
		const out = await hooks.tools.view("error", { body: "boom" });
		assert.equal(out, "# error\nboom");
	});

	it("summarized projection returns body unchanged", async () => {
		const { hooks } = makeCore();
		const out = await hooks.tools.view("error", {
			body: "boom",
			visibility: "summarized",
		});
		assert.equal(out, "boom");
	});
});

describe("error plugin: error.log handler", () => {
	it("hard error: writes failed entry with status:N outcome and increments turn errors", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const store = makeStore();
		await hooks.error.log.emit({
			store,
			runId: "r",
			turn: 1,
			loopId: "L1",
			message: "bad thing",
			status: 422,
			attributes: { ext: "y" },
		});
		assert.equal(store._calls.length, 1);
		const entry = store._calls[0];
		assert.equal(entry.state, "failed");
		assert.equal(entry.outcome, "status:422");
		assert.equal(entry.attributes.status, 422);
		assert.equal(entry.attributes.ext, "y");
	});

	it("soft error: state=resolved, outcome=null, no strike side effect", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const store = makeStore();
		await hooks.error.log.emit({
			store,
			runId: "r",
			turn: 1,
			loopId: "L1",
			message: "minor parser warning",
			status: 400,
			soft: true,
			attributes: {},
		});
		assert.equal(store._calls[0].state, "resolved");
		assert.equal(store._calls[0].outcome, null);
		assert.equal(store._calls[0].attributes.status, 400);
	});

	it("default status is 400 when none provided", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const store = makeStore();
		await hooks.error.log.emit({
			store,
			runId: "r",
			turn: 1,
			loopId: "L1",
			message: "x",
			attributes: {},
		});
		assert.equal(store._calls[0].outcome, "status:400");
	});
});

describe("error plugin: verdict", () => {
	it("clean turn (no recorded errors, no summary) → continue: true, no streak", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const verdict = await hooks.turn.verdict.filter(
			{ continue: true },
			{
				store: makeStore(),
				runId: "r",
				loopId: "L1",
				recorded: [],
				summaryText: null,
			},
		);
		assert.deepEqual(verdict, { continue: true });
	});

	it("clean turn with summary → terminal continue=false, status=200 by default", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const verdict = await hooks.turn.verdict.filter(
			{ continue: true },
			{
				store: makeStore(),
				runId: "r",
				loopId: "L1",
				recorded: [],
				summaryText: "all good",
			},
		);
		assert.equal(verdict.continue, false);
		assert.equal(verdict.status, 200);
	});

	it("summary with explicit update.status overrides default 200", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const verdict = await hooks.turn.verdict.filter(
			{ continue: true },
			{
				store: makeStore(),
				runId: "r",
				loopId: "L1",
				recorded: [
					{
						scheme: "update",
						attributes: { status: 145 },
						path: "log://turn_1/update/x",
					},
				],
				summaryText: "decompose",
			},
		);
		assert.equal(verdict.status, 145);
	});

	it("turn with hard error: emits Missing-update reminder and increments streak", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const store = makeStore();
		await hooks.error.log.emit({
			store,
			runId: "r",
			turn: 1,
			loopId: "L1",
			message: "x",
			attributes: {},
		});
		const verdict = await hooks.turn.verdict.filter(
			{ continue: true },
			{
				store,
				runId: "r",
				loopId: "L1",
				recorded: [],
				summaryText: null,
			},
		);
		assert.equal(verdict.continue, true);
		assert.match(verdict.reason, /Missing update/);
	});

	it("recorded HARD-failed entry (validation outcome) counts as strike", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const stateByPath = new Map([
			["log://turn_1/set/x", { state: "failed", outcome: "validation" }],
		]);
		const store = makeStore({ stateByPath });
		const recorded = [
			{
				scheme: "set",
				path: "log://turn_1/set/x",
				attributes: { path: "x" },
			},
		];
		const verdict = await hooks.turn.verdict.filter(
			{ continue: true },
			{
				store,
				runId: "r",
				loopId: "L1",
				recorded,
				summaryText: null,
			},
		);
		assert.equal(verdict.continue, true);
		assert.match(verdict.reason, /Missing update/);
	});

	it("recorded SOFT-failed entry (not_found outcome) does NOT strike", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const stateByPath = new Map([
			["log://turn_1/set/x", { state: "failed", outcome: "not_found" }],
		]);
		const store = makeStore({ stateByPath });
		const recorded = [
			{
				scheme: "set",
				path: "log://turn_1/set/x",
				attributes: { path: "x" },
			},
		];
		const verdict = await hooks.turn.verdict.filter(
			{ continue: true },
			{
				store,
				runId: "r",
				loopId: "L1",
				recorded,
				summaryText: null,
			},
		);
		// not_found is a finding, not a contract violation — the model
		// adapts and re-tries. Run continues without striking.
		assert.deepEqual(verdict, { continue: true });
	});

	it("recorded SOFT-failed entry (conflict outcome) does NOT strike", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const stateByPath = new Map([
			["log://turn_1/set/x", { state: "failed", outcome: "conflict" }],
		]);
		const store = makeStore({ stateByPath });
		const recorded = [
			{
				scheme: "set",
				path: "log://turn_1/set/x",
				attributes: { path: "x" },
			},
		];
		const verdict = await hooks.turn.verdict.filter(
			{ continue: true },
			{
				store,
				runId: "r",
				loopId: "L1",
				recorded,
				summaryText: null,
			},
		);
		assert.deepEqual(verdict, { continue: true });
	});

	it("repeated not_found failures (varied paths) do NOT accumulate strikes via recordedFailed", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		// Vary paths each iteration so cycle detection (orthogonal strike
		// source) doesn't conflate with the recordedFailed path we're
		// testing here. Pair each turn with a 155 update so the model
		// stays in Distillation (phase 5, exempt from stagnation) — this
		// test isolates the recordedFailed soft-vs-hard distinction, not
		// stagnation pressure.
		const stateByPath = new Map();
		let verdict;
		for (let i = 0; i < MAX_STRIKES + 5; i++) {
			const path = `log://turn_${i + 1}/set/x${i}`;
			stateByPath.set(path, { state: "failed", outcome: "not_found" });
			const store = makeStore({ stateByPath });
			verdict = await hooks.turn.verdict.filter(
				{ continue: true },
				{
					store,
					runId: "r",
					turn: i + 1,
					loopId: "L1",
					recorded: [
						{ scheme: "set", path, attributes: { path: `x${i}` } },
						{
							scheme: "update",
							path: `log://turn_${i + 1}/update/x`,
							attributes: { status: 155 },
						},
					],
					summaryText: null,
				},
			);
		}
		assert.equal(verdict.continue, true);
		assert.equal(verdict.status, undefined);
	});

	it("after MAX_STRIKES strikes without summary: abandons run with status 499", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		const store = makeStore();
		// MAX_STRIKES turns of error.log → verdict with no summary.
		let verdict;
		for (let i = 1; i <= MAX_STRIKES; i++) {
			await startTurn(hooks, "L1", i);
			await hooks.error.log.emit({
				store,
				runId: "r",
				turn: i,
				loopId: "L1",
				message: `err${i}`,
				attributes: {},
			});
			verdict = await hooks.turn.verdict.filter(
				{ continue: true },
				{
					store,
					runId: "r",
					loopId: "L1",
					recorded: [],
					summaryText: null,
				},
			);
		}
		assert.equal(verdict.continue, false);
		assert.equal(verdict.status, 499);
		// Reason may be cycle-detected or strike-count, both are 499 outcomes.
		assert.match(verdict.reason, /Loop detected|Abandoned/);
	});

	it("MAX_STRIKES with terminal summary: still completes successfully (summary wins over 499)", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		const store = makeStore();
		let verdict;
		for (let i = 1; i <= MAX_STRIKES; i++) {
			await startTurn(hooks, "L1", i);
			await hooks.error.log.emit({
				store,
				runId: "r",
				turn: i,
				loopId: "L1",
				message: `err${i}`,
				attributes: {},
			});
			verdict = await hooks.turn.verdict.filter(
				{ continue: true },
				{
					store,
					runId: "r",
					loopId: "L1",
					recorded: [
						{
							scheme: "update",
							attributes: { status: 200 },
							path: `log://turn_${i}/update/x`,
						},
					],
					summaryText: "done",
				},
			);
		}
		assert.equal(verdict.continue, false);
		assert.equal(verdict.status, 200);
	});

	it("cycle detection: identical fingerprints repeated MIN_CYCLES times → strike with 'Loop detected'", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		const store = makeStore();
		// Force MIN_CYCLES iterations of identical fingerprint=set:path=x.
		// At MIN_CYCLES-th call, detectCycle returns true and verdict signals streak.
		const recorded = [
			{
				scheme: "set",
				attributes: { path: "x", a: null },
				path: "log://turn_1/set/x",
			},
		];
		let verdict;
		for (let i = 1; i <= MIN_CYCLES; i++) {
			await startTurn(hooks, "L1", i);
			verdict = await hooks.turn.verdict.filter(
				{ continue: true },
				{
					store,
					runId: "r",
					loopId: "L1",
					recorded,
					summaryText: null,
				},
			);
		}
		// Cycle detected on the MIN_CYCLES-th call → struck → continue:true
		// with Missing-update reminder (until MAX_STRIKES).
		assert.equal(verdict.continue, true);
		assert.match(verdict.reason, /Missing update/);
	});

	it("loop.completed clears state for the loopId", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await hooks.loop.completed.emit({ loopId: "L1" });
		// turn.started against a cleared loop will throw; verifies state was deleted.
		await assert.rejects(
			startTurn(hooks, "L1"),
			/Cannot set properties of undefined/,
		);
	});
});

// Per-stage stagnation pressure: turns 1–6 in the same phase are free,
// each turn after that fires a strike via the same error.log channel.
describe("error plugin: stage-stagnation strikes", () => {
	function _turnUpdate(turn, status) {
		return {
			path: `log://turn_${turn}/update/x`,
			attributes: { status },
		};
	}

	it("turns 1–3 in Decomposition (phase 4): no stagnation strike fires", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		const store = makeStore();
		for (let t = 1; t <= 3; t++) {
			await runVerdict(hooks, store, "L1", t, null);
		}
		const stagnationCalls = store._calls.filter(
			(c) => c.body && /turns in current stage/.test(c.body),
		);
		assert.equal(stagnationCalls.length, 0);
	});

	it("turn 4 in Decomposition: strike fires with phase-aware message", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		const store = makeStore();
		for (let t = 1; t <= 4; t++) {
			await runVerdict(hooks, store, "L1", t, null);
		}
		const stagnationCalls = store._calls.filter(
			(c) => c.body && /turns in current stage/.test(c.body),
		);
		assert.equal(stagnationCalls.length, 1);
		assert.match(
			stagnationCalls[0].body,
			/^4 turns in current stage\. Attempt to proceed to next stage\.$/,
		);
		assert.equal(stagnationCalls[0].state, "failed");
		assert.equal(stagnationCalls[0].outcome, "status:408");
		assert.equal(stagnationCalls[0].attributes.stagnation, true);
		assert.equal(stagnationCalls[0].attributes.phase, 4);
	});

	it("Distillation (phase 5) is exempt: no stagnation strike no matter how many turns", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		const store = makeStore();
		// 22 consecutive turns emitting status=145 (Decomposition→Distillation
		// transition; phase 5). Distillation must accumulate no strikes —
		// hard sub-problems get to grind.
		for (let t = 1; t <= 22; t++) {
			await runVerdict(hooks, store, "L1", t, 145);
		}
		const stagnationCalls = store._calls.filter(
			(c) => c.body && /turns in current stage/.test(c.body),
		);
		assert.equal(
			stagnationCalls.length,
			0,
			"Distillation phase is exempt from stagnation strikes",
		);
	});

	it("Demotion (phase 6) is gated: turn 4 in same stage strikes", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		const store = makeStore();
		// Four consecutive turns emitting 156 (Distill complete → phase 6).
		// Strike fires on the 4th turn-in-phase-6.
		for (let t = 1; t <= 4; t++) {
			await runVerdict(hooks, store, "L1", t, 156);
		}
		const stagnationCalls = store._calls.filter(
			(c) => c.body && /turns in current stage/.test(c.body),
		);
		assert.equal(stagnationCalls.length, 1);
		assert.equal(stagnationCalls[0].attributes.phase, 6);
	});

	it("Deployment (phase 7) is exempt: no stagnation strike no matter how many turns", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		const store = makeStore();
		// 22 turns emitting 167 (Demotion Complete → Deployment, phase 7).
		for (let t = 1; t <= 22; t++) {
			await runVerdict(hooks, store, "L1", t, 167);
		}
		const stagnationCalls = store._calls.filter(
			(c) => c.body && /turns in current stage/.test(c.body),
		);
		assert.equal(
			stagnationCalls.length,
			0,
			"Deployment phase is exempt from stagnation strikes",
		);
	});

	it("model advancing on the strike-eligible turn cancels the strike", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		const store = makeStore();
		// Three turns in Demotion (phase 6), then on what would be the
		// strike turn the model emits 167 (advance to Deployment, phase 7).
		// Pre-fix, the strike pre-fired at turn-start before the model's
		// emission could change the phase, blocking the abandoning-strike
		// rescue. Verdict-time stagnation honors the actual emission.
		for (let t = 1; t <= 3; t++) {
			await runVerdict(hooks, store, "L1", t, 156);
		}
		const verdict = await runVerdict(hooks, store, "L1", 4, 167);
		const stagnationCalls = store._calls.filter(
			(c) => c.body && /turns in current stage/.test(c.body),
		);
		assert.equal(stagnationCalls.length, 0, "advance cancels the strike");
		assert.equal(verdict.continue, true);
	});

	it("MAX_STRIKES consecutive stagnation strikes terminate the run with 499", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		const store = makeStore();
		let verdict;
		for (let t = 1; t <= 3 + MAX_STRIKES; t++) {
			verdict = await runVerdict(hooks, store, "L1", t, null);
		}
		assert.equal(verdict.continue, false);
		assert.equal(verdict.status, 499);
	});
});
