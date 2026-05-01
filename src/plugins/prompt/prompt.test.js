import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import Prompt from "./prompt.js";

function makeCore({ tools = ["set", "get"] } = {}) {
	const hooks = createHooks();
	for (const t of tools) hooks.tools.ensureTool(t);
	const core = new PluginContext("prompt", hooks);
	new Prompt(core);
	return { hooks, core };
}

describe("Prompt plugin", () => {
	it("registers prompt visible/summarized views", async () => {
		const { hooks } = makeCore();
		assert.ok(hooks.tools.hasView("prompt"));
		const visible = await hooks.tools.view("prompt", {
			body: "hi",
			visibility: "visible",
		});
		assert.equal(visible, "hi");
	});

	it("summarized view returns body unchanged when ≤ cap", async () => {
		const { hooks } = makeCore();
		const out = await hooks.tools.view("prompt", {
			body: "short",
			visibility: "summarized",
		});
		assert.equal(out, "short");
	});

	it("summarized view truncates body and appends marker when > cap", async () => {
		const { hooks } = makeCore();
		const body = "x".repeat(600);
		const out = await hooks.tools.view("prompt", {
			body,
			visibility: "summarized",
		});
		assert.match(out, /truncated — promote to see/);
		assert.ok(out.length < body.length + 100);
	});

	describe("turn.started: archive + record prompt", () => {
		function buildRummy() {
			const calls = [];
			const archives = [];
			const store = {
				archivePriorPromptArtifacts: async (runId, turn) => {
					archives.push({ runId, turn });
				},
				set: async (args) => calls.push(args),
			};
			return {
				rummy: {
					entries: store,
					sequence: 3,
					runId: "r",
					loopId: "l",
				},
				calls,
				archives,
			};
		}

		it("on new prompt: archives prior artifacts and writes prompt://N", async () => {
			const { hooks } = makeCore();
			const { rummy, calls, archives } = buildRummy();
			await hooks.turn.started.emit({
				rummy,
				mode: "act",
				prompt: "do thing",
				isContinuation: false,
			});
			assert.equal(archives.length, 1);
			assert.deepEqual(archives[0], { runId: "r", turn: 3 });
			assert.equal(calls.length, 1);
			assert.equal(calls[0].path, "prompt://3");
			assert.equal(calls[0].body, "do thing");
			assert.equal(calls[0].attributes.mode, "act");
			assert.equal(calls[0].writer, "plugin");
		});

		it("on continuation: writes nothing (no archive, no prompt entry)", async () => {
			const { hooks } = makeCore();
			const { rummy, calls, archives } = buildRummy();
			await hooks.turn.started.emit({
				rummy,
				mode: "act",
				prompt: "do thing",
				isContinuation: true,
			});
			assert.equal(archives.length, 0);
			assert.equal(calls.length, 0);
		});

		it("with no prompt arg: writes nothing", async () => {
			const { hooks } = makeCore();
			const { rummy, calls } = buildRummy();
			await hooks.turn.started.emit({
				rummy,
				mode: "act",
				prompt: null,
				isContinuation: false,
			});
			assert.equal(calls.length, 0);
		});
	});

	describe("assembly.user filter renders <prompt>", () => {
		function ctxWith(rows, extras = {}) {
			return {
				rows,
				toolSet: ["set", "get"],
				type: "act",
				turn: 2,
				...extras,
			};
		}

		it("renders <prompt> with mode + commands when prompt entry present", async () => {
			const { hooks } = makeCore();
			const out = await hooks.assembly.user.filter(
				"PRE",
				ctxWith([
					{
						path: "prompt://1",
						scheme: "prompt",
						category: "prompt",
						body: "hello",
						attributes: { mode: "ask" },
					},
				]),
			);
			assert.match(out, /^PRE/);
			assert.match(out, /<prompt mode="ask"/);
			assert.match(out, /commands="get,set"/);
			assert.match(out, />hello<\/prompt>/);
		});

		it('ask mode triggers warn="File editing disallowed."', async () => {
			const { hooks } = makeCore();
			const out = await hooks.assembly.user.filter(
				"",
				ctxWith([
					{
						path: "prompt://1",
						scheme: "prompt",
						category: "prompt",
						body: "x",
						attributes: { mode: "ask" },
					},
				]),
			);
			assert.match(out, /warn="File editing disallowed."/);
		});

		it("falls back to ctx.type when prompt entry has no mode attribute", async () => {
			const { hooks } = makeCore();
			const out = await hooks.assembly.user.filter(
				"",
				ctxWith(
					[
						{
							path: "prompt://1",
							scheme: "prompt",
							category: "prompt",
							body: "",
							attributes: {},
						},
					],
					{ type: "ask" },
				),
			);
			assert.match(out, /<prompt mode="ask"/);
		});

		it('includes reverted="N" when prior turn had a 413 demotion', async () => {
			const { hooks } = makeCore();
			const out = await hooks.assembly.user.filter(
				"",
				ctxWith([
					{
						path: "prompt://2",
						scheme: "prompt",
						category: "prompt",
						body: "x",
						attributes: { mode: "act" },
					},
					{
						path: "log://turn_1/error/budget",
						scheme: "log",
						category: "logging",
						attributes: { status: 413, demotedCount: 4 },
					},
				]),
			);
			assert.match(out, /reverted="4"/);
		});

		it("omits reverted attribute when no 413 in prior turn", async () => {
			const { hooks } = makeCore();
			const out = await hooks.assembly.user.filter(
				"",
				ctxWith([
					{
						path: "prompt://2",
						scheme: "prompt",
						category: "prompt",
						body: "x",
						attributes: { mode: "act" },
					},
				]),
			);
			assert.equal(out.includes("reverted="), false);
		});

		it("renders empty body and no path when no prompt entry exists", async () => {
			const { hooks } = makeCore();
			const out = await hooks.assembly.user.filter("", ctxWith([]));
			assert.match(out, /<prompt mode="act"/);
			assert.equal(out.includes("path="), false);
			assert.match(out, /><\/prompt>$/);
		});
	});
});
