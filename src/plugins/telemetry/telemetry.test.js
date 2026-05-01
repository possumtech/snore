import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import Telemetry from "./telemetry.js";

// Suppress console noise for [RPC] and [DEBUG] log lines while still letting us assert on them.
function captureConsole() {
	const out = [];
	const err = [];
	const oLog = console.log;
	const oErr = console.error;
	console.log = (...args) => out.push(args.join(" "));
	console.error = (...args) => err.push(args.join(" "));
	return {
		out,
		err,
		restore() {
			console.log = oLog;
			console.error = oErr;
		},
	};
}

function makeCore() {
	const hooks = createHooks();
	const core = new PluginContext("telemetry", hooks);
	new Telemetry(core);
	return { hooks };
}

describe("Telemetry plugin", () => {
	let originalHome;
	let originalDebug;
	let tmpHome;
	let cap;

	beforeEach(async () => {
		originalHome = process.env.RUMMY_HOME;
		originalDebug = process.env.RUMMY_DEBUG;
		tmpHome = await mkdtemp(join(tmpdir(), "telem-test-"));
		process.env.RUMMY_HOME = tmpHome;
		cap = captureConsole();
	});

	afterEach(async () => {
		cap.restore();
		if (originalHome === undefined) delete process.env.RUMMY_HOME;
		else process.env.RUMMY_HOME = originalHome;
		if (originalDebug === undefined) delete process.env.RUMMY_DEBUG;
		else process.env.RUMMY_DEBUG = originalDebug;
		await rm(tmpHome, { recursive: true, force: true });
	});

	describe("RPC logging", () => {
		it("logs [RPC] → on rpc.started", async () => {
			const { hooks } = makeCore();
			await hooks.rpc.started.emit({ method: "ping", id: 1, params: {} });
			assert.ok(cap.out.some((l) => /\[RPC\] → ping\(1\)/.test(l)));
		});

		it("logs prompt summary for set on run://", async () => {
			const { hooks } = makeCore();
			await hooks.rpc.started.emit({
				method: "set",
				id: 2,
				params: { path: "run://x", body: "do the thing" },
			});
			assert.ok(cap.out.some((l) => /prompt="do the thing"/.test(l)));
		});

		it("logs run/abort summary including run alias", async () => {
			const { hooks } = makeCore();
			await hooks.rpc.started.emit({
				method: "run/abort",
				id: 3,
				params: { run: "alpha" },
			});
			assert.ok(cap.out.some((l) => /run=alpha/.test(l)));
		});

		it("logs [RPC] ← on rpc.completed with elapsed time", async () => {
			const { hooks } = makeCore();
			await hooks.rpc.started.emit({ method: "ping", id: 9, params: {} });
			await hooks.rpc.completed.emit({
				method: "ping",
				id: 9,
				result: { status: "ok" },
			});
			assert.ok(
				cap.out.some((l) => /\[RPC\] ← ping\(9\) [0-9.]+s status=ok/.test(l)),
			);
		});

		it("logs [RPC] ✗ on rpc.error", async () => {
			const { hooks } = makeCore();
			await hooks.rpc.started.emit({ method: "ping", id: 4, params: {} });
			await hooks.rpc.error.emit({ id: 4, error: new Error("boom") });
			assert.ok(cap.err.some((l) => /\[RPC\] ✗ \(4\).*boom/.test(l)));
		});
	});

	describe("run.step.completed gating on RUMMY_DEBUG", () => {
		it("logs nothing without RUMMY_DEBUG=true", async () => {
			delete process.env.RUMMY_DEBUG;
			const { hooks } = makeCore();
			await hooks.run.step.completed.emit({ turn: 1, run: "r" });
			assert.ok(!cap.out.some((l) => /\[DEBUG\] Turn/.test(l)));
		});

		it("logs [DEBUG] Turn N with RUMMY_DEBUG=true", async () => {
			process.env.RUMMY_DEBUG = "true";
			const { hooks } = makeCore();
			await hooks.run.step.completed.emit({ turn: 1, run: "r" });
			assert.ok(cap.out.some((l) => /\[DEBUG\] Turn 1 completed/.test(l)));
		});
	});

	describe("turn.response audit writes", () => {
		function makeRummy() {
			const calls = [];
			return {
				_calls: calls,
				rummy: {
					entries: {
						set: async (p) => calls.push(p),
						updateTurnStats: async (p) => calls.push({ updateStats: p }),
					},
					runId: "r",
					loopId: "l",
					turnId: "tid",
				},
			};
		}

		it("writes assistant://N + system://N + user://N + model://N", async () => {
			const { hooks } = makeCore();
			const { rummy, _calls: calls } = makeRummy();
			await hooks.turn.response.emit({
				rummy,
				turn: 4,
				result: {
					usage: {
						prompt_tokens: 100,
						completion_tokens: 50,
						total_tokens: 150,
					},
					model: "test-model",
				},
				responseMessage: { reasoning_content: null },
				content: "hello world",
				unparsed: null,
				assembledTokens: 95,
				systemMsg: "SYS",
				userMsg: "USR",
			});
			const paths = calls.filter((c) => !c.updateStats).map((c) => c.path);
			assert.ok(paths.includes("assistant://4"));
			assert.ok(paths.includes("system://4"));
			assert.ok(paths.includes("user://4"));
			assert.ok(paths.includes("model://4"));
			assert.equal(paths.includes("reasoning://4"), false);
			const assistant = calls.find((c) => c.path === "assistant://4");
			assert.equal(assistant.body, "hello world");
		});

		it("writes reasoning://N when responseMessage has reasoning_content", async () => {
			const { hooks } = makeCore();
			const { rummy, _calls: calls } = makeRummy();
			await hooks.turn.response.emit({
				rummy,
				turn: 1,
				result: { usage: { prompt_tokens: 1 } },
				responseMessage: { reasoning_content: "thoughts" },
				content: "out",
				unparsed: null,
				assembledTokens: 0,
				systemMsg: "",
				userMsg: "",
			});
			const reasoning = calls.find((c) => c.path === "reasoning://1");
			assert.ok(reasoning);
			assert.equal(reasoning.body, "thoughts");
		});

		it("writes content://N as visible+failed when unparsed text present", async () => {
			const { hooks } = makeCore();
			const { rummy, _calls: calls } = makeRummy();
			await hooks.turn.response.emit({
				rummy,
				turn: 2,
				result: { usage: {} },
				responseMessage: {},
				content: "ok",
				unparsed: "<bad>tag</bad>",
				assembledTokens: 0,
				systemMsg: "",
				userMsg: "",
			});
			const content = calls.find((c) => c.path === "content://2");
			assert.ok(content);
			assert.equal(content.state, "failed");
			assert.equal(content.outcome, "unparsed");
			assert.equal(content.visibility, "visible");
		});

		it("calls updateTurnStats with cost from upstream_inference_cost when usage.cost is 0", async () => {
			const { hooks } = makeCore();
			const { rummy, _calls: calls } = makeRummy();
			await hooks.turn.response.emit({
				rummy,
				turn: 1,
				result: {
					usage: {
						prompt_tokens: 10,
						completion_tokens: 5,
						total_tokens: 15,
						cost: 0,
						cost_details: { upstream_inference_cost: 0.42 },
					},
				},
				responseMessage: {},
				content: "x",
				unparsed: null,
				assembledTokens: 0,
				systemMsg: "",
				userMsg: "",
			});
			const stats = calls.find((c) => c.updateStats);
			assert.ok(stats);
			assert.equal(stats.updateStats.cost, 0.42);
		});

		it("falls back to assembledTokens when usage.prompt_tokens missing", async () => {
			const { hooks } = makeCore();
			const { rummy, _calls: calls } = makeRummy();
			await hooks.turn.response.emit({
				rummy,
				turn: 1,
				result: { usage: {} },
				responseMessage: {},
				content: "",
				unparsed: null,
				assembledTokens: 77,
				systemMsg: "",
				userMsg: "",
			});
			const stats = calls.find((c) => c.updateStats);
			assert.equal(stats.updateStats.context_tokens, 77);
		});
	});

	describe("llm.messages / llm.response file logging", () => {
		it("flushes turn log to RUMMY_HOME/last_run.txt and RUMMY_HOME/turns/{run}/turn_NNN.txt", async () => {
			const { hooks } = makeCore();
			await hooks.llm.messages.filter(
				[
					{ role: "system", content: "S" },
					{ role: "user", content: "U" },
				],
				{ runAlias: "alpha", turn: 1, model: "m" },
			);
			await hooks.llm.response.filter(
				{
					choices: [
						{
							message: { content: "out", reasoning_content: "thought" },
						},
					],
					usage: { total_tokens: 10 },
				},
				{ runAlias: "alpha", turn: 1, model: "m" },
			);
			// Allow async writeFile to flush.
			await new Promise((r) => setTimeout(r, 50));
			const last = await readFile(join(tmpHome, "last_run.txt"), "utf8");
			assert.match(last, /TURN 1/);
			assert.match(last, /SYSTEM/);
			assert.match(last, /USER/);
			assert.match(last, /ASSISTANT/);
			assert.match(last, /REASONING/);
			const turn = await readFile(
				join(tmpHome, "turns", "alpha", "turn_001.txt"),
				"utf8",
			);
			assert.match(turn, /TURN 1/);
		});

		it("resets turn log buffer when run alias changes", async () => {
			const { hooks } = makeCore();
			await hooks.llm.messages.filter([{ role: "user", content: "U-alpha" }], {
				runAlias: "alpha",
				turn: 1,
				model: "m",
			});
			await hooks.llm.response.filter(
				{ choices: [{ message: { content: "x" } }], usage: {} },
				{ runAlias: "alpha", turn: 1, model: "m" },
			);
			await hooks.llm.messages.filter([{ role: "user", content: "U-beta" }], {
				runAlias: "beta",
				turn: 1,
				model: "m",
			});
			await hooks.llm.response.filter(
				{ choices: [{ message: { content: "y" } }], usage: {} },
				{ runAlias: "beta", turn: 1, model: "m" },
			);
			await new Promise((r) => setTimeout(r, 50));
			const last = await readFile(join(tmpHome, "last_run.txt"), "utf8");
			assert.equal(last.includes("U-alpha"), false);
			assert.match(last, /U-beta/);
		});
	});
});
