import assert from "node:assert/strict";
import { describe, it } from "node:test";
import config from "../../agent/config.js";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import ErrorPlugin from "./error.js";

const { MAX_STRIKES, MIN_CYCLES } = config;

function makeCore() {
	const hooks = createHooks();
	const core = new PluginContext("error", hooks);
	new ErrorPlugin(core);
	return { hooks, core };
}

function makeStore({ stateByPath = new Map() } = {}) {
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
	};
}

async function startLoop(hooks, loopId) {
	await hooks.loop.started.emit({ loopId });
}

async function startTurn(hooks, loopId, sequence = 1) {
	await hooks.turn.started.emit({
		rummy: { loopId, sequence, runId: "r", entries: {} },
	});
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
		const verdict = await hooks.error.verdict({
			store: makeStore(),
			runId: "r",
			loopId: "L1",
			recorded: [],
			summaryText: null,
		});
		assert.deepEqual(verdict, { continue: true });
	});

	it("clean turn with summary → terminal continue=false, status=200 by default", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const verdict = await hooks.error.verdict({
			store: makeStore(),
			runId: "r",
			loopId: "L1",
			recorded: [],
			summaryText: "all good",
		});
		assert.equal(verdict.continue, false);
		assert.equal(verdict.status, 200);
	});

	it("summary with explicit update.status overrides default 200", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const verdict = await hooks.error.verdict({
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
		});
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
		const verdict = await hooks.error.verdict({
			store,
			runId: "r",
			loopId: "L1",
			recorded: [],
			summaryText: null,
		});
		assert.equal(verdict.continue, true);
		assert.match(verdict.reason, /Missing update/);
	});

	it("recorded failed entry counts as strike even without error.log", async () => {
		const { hooks } = makeCore();
		await startLoop(hooks, "L1");
		await startTurn(hooks, "L1");
		const stateByPath = new Map([["log://turn_1/set/x", { state: "failed" }]]);
		const store = makeStore({ stateByPath });
		const recorded = [
			{
				scheme: "set",
				path: "log://turn_1/set/x",
				attributes: { path: "x" },
			},
		];
		const verdict = await hooks.error.verdict({
			store,
			runId: "r",
			loopId: "L1",
			recorded,
			summaryText: null,
		});
		assert.equal(verdict.continue, true);
		assert.match(verdict.reason, /Missing update/);
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
			verdict = await hooks.error.verdict({
				store,
				runId: "r",
				loopId: "L1",
				recorded: [],
				summaryText: null,
			});
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
			verdict = await hooks.error.verdict({
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
			});
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
			verdict = await hooks.error.verdict({
				store,
				runId: "r",
				loopId: "L1",
				recorded,
				summaryText: null,
			});
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
