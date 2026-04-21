import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import createHooks from "../hooks/Hooks.js";
import { registerPlugins } from "../plugins/index.js";
import ContextAssembler from "./ContextAssembler.js";

let hooks;

before(async () => {
	hooks = createHooks();
	const pluginsDir = join(
		dirname(fileURLToPath(import.meta.url)),
		"../plugins",
	);
	await registerPlugins([pluginsDir], hooks);
});

describe("ContextAssembler", () => {
	describe("assembleFromTurnContext", () => {
		it("renders system prompt + known + user prompt", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "known://auth",
					scheme: "known",
					fidelity: "promoted",
					body: "JWT",
					tokens: 1,
					attributes: null,
					category: "data",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "src/app.js",
					scheme: null,
					fidelity: "promoted",
					body: "const x = 1;",
					tokens: 5,
					attributes: null,
					category: "data",
					source_turn: 1,
				},
				{
					ordinal: 3,
					path: "prompt://1",
					scheme: "prompt",
					fidelity: "promoted",
					body: "What does this do?",
					tokens: 3,
					attributes: JSON.stringify({ mode: "ask" }),
					category: "prompt",
					source_turn: 1,
				},
			];
			const messages = await ContextAssembler.assembleFromTurnContext(
				rows,
				{ systemPrompt: "You are helpful." },
				hooks,
			);

			assert.strictEqual(messages.length, 2);
			assert.strictEqual(messages[0].role, "system");
			assert.ok(messages[0].content.includes("You are helpful."));
			assert.ok(messages[0].content.includes("known://auth"));
			assert.ok(messages[0].content.includes("const x = 1;"));
			assert.ok(messages[0].content.includes("<known path="));
			assert.strictEqual(messages[1].role, "user");
			assert.ok(messages[1].content.includes("<prompt"));
			assert.ok(messages[1].content.includes("What does this do?"));
		});

		it("prompt always appears last in user message", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "prompt://1",
					scheme: "prompt",
					fidelity: "promoted",
					body: "The question",
					tokens: 3,
					attributes: JSON.stringify({ mode: "ask" }),
					category: "prompt",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "get://file.js",
					scheme: "get",
					fidelity: "promoted",
					state: "resolved",
					body: "file content",
					tokens: 5,
					attributes: JSON.stringify({ path: "file.js" }),
					category: "logging",
					source_turn: 1,
				},
			];
			const messages = await ContextAssembler.assembleFromTurnContext(
				rows,
				{ systemPrompt: "sys" },
				hooks,
			);

			const user = messages[1].content;
			const logPos = user.indexOf("<log>");
			const promptPos = user.indexOf("<prompt");
			assert.ok(logPos < promptPos, "log before prompt");
			assert.ok(user.endsWith("</prompt>"), "prompt is last");
		});

		it("unifies all logging entries across loops into a single <log> block", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "get://old.js",
					scheme: "get",
					fidelity: "promoted",
					state: "resolved",
					body: "old result",
					tokens: 5,
					attributes: JSON.stringify({ path: "old.js" }),
					category: "logging",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "prompt://3",
					scheme: "prompt",
					fidelity: "promoted",
					body: "New question",
					tokens: 3,
					attributes: JSON.stringify({ mode: "ask" }),
					category: "prompt",
					source_turn: 3,
				},
				{
					ordinal: 3,
					path: "get://new.js",
					scheme: "get",
					fidelity: "promoted",
					state: "resolved",
					body: "new result",
					tokens: 5,
					attributes: JSON.stringify({ path: "new.js" }),
					category: "logging",
					source_turn: 3,
				},
			];
			const messages = await ContextAssembler.assembleFromTurnContext(
				rows,
				{ systemPrompt: "sys" },
				hooks,
			);

			const system = messages[0].content;
			const user = messages[1].content;
			assert.ok(!system.includes("<previous>"), "no <previous> block");
			assert.ok(!system.includes("<log>"), "log is not in system");
			assert.ok(user.includes("<log>"), "user has log");
			assert.ok(user.includes("old.js"), "old get in log");
			assert.ok(user.includes("new.js"), "new get in log");
		});

		it("renders results with status symbols in log", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "prompt://1",
					scheme: "prompt",
					fidelity: "promoted",
					body: "Fix it",
					tokens: 2,
					attributes: JSON.stringify({ mode: "act" }),
					category: "prompt",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "set://app.js",
					scheme: "set",
					fidelity: "promoted",
					state: "resolved",
					body: "",
					tokens: 0,
					attributes: JSON.stringify({ path: "app.js" }),
					category: "logging",
					source_turn: 1,
				},
				{
					ordinal: 3,
					path: "update://done",
					scheme: "update",
					fidelity: "promoted",
					state: "resolved",
					body: "Fixed it",
					tokens: 2,
					attributes: null,
					category: "logging",
					source_turn: 1,
				},
			];
			const messages = await ContextAssembler.assembleFromTurnContext(
				rows,
				{ systemPrompt: "sys" },
				hooks,
			);
			const user = messages[1].content;

			assert.ok(user.includes('status="200"'), "pass result has status");
			assert.ok(user.includes("Fixed it"), "summary renders");
			assert.ok(user.includes("<log>"), "results in log block");
			assert.ok(
				user.includes("<set path="),
				"tool tags in log use tool name",
			);
		});

		it("renders empty context when no entries", async () => {
			const rows = [];
			const messages = await ContextAssembler.assembleFromTurnContext(
				rows,
				{ systemPrompt: "sys" },
				hooks,
			);

			assert.strictEqual(messages.length, 2);
			assert.strictEqual(messages[0].content, "sys");
			assert.strictEqual(messages[1].role, "user");
			assert.ok(messages[1].content.includes("<prompt"));
		});

		it("renders known entries in row order", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "src/app.js",
					scheme: null,
					fidelity: "promoted",
					body: "const x = 1;",
					tokens: 5,
					attributes: null,
					category: "data",
					source_turn: 3,
				},
				{
					ordinal: 2,
					path: "src/old.js",
					scheme: null,
					fidelity: "promoted",
					body: "const y = 2;",
					tokens: 5,
					attributes: null,
					category: "data",
					source_turn: 1,
				},
				{
					ordinal: 3,
					path: "known://auth",
					scheme: "known",
					fidelity: "promoted",
					body: "JWT",
					tokens: 1,
					attributes: null,
					category: "data",
					source_turn: 2,
				},
			];
			const messages = await ContextAssembler.assembleFromTurnContext(
				rows,
				{ systemPrompt: "sys" },
				hooks,
			);
			const content = messages[0].content;

			assert.ok(content.includes("<known path="));
			assert.ok(content.includes("const y = 2;"), "old file rendered");
			assert.ok(content.includes("JWT"), "known rendered");
			assert.ok(content.includes("const x = 1;"), "new file rendered");
		});

		it("renders unknowns in their own <unknowns> block in the user message", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "unknown://config",
					scheme: "unknown",
					fidelity: "promoted",
					body: "which database adapter",
					tokens: 3,
					attributes: null,
					category: "unknown",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "prompt://1",
					scheme: "prompt",
					fidelity: "promoted",
					body: "Do it",
					tokens: 2,
					attributes: JSON.stringify({ mode: "act" }),
					category: "prompt",
					source_turn: 1,
				},
			];
			const messages = await ContextAssembler.assembleFromTurnContext(
				rows,
				{ systemPrompt: "sys" },
				hooks,
			);
			const user = messages[1].content;
			const system = messages[0].content;

			assert.ok(user.includes("<unknowns>"), "unknowns block rendered");
			assert.ok(
				user.includes('<unknown path="unknown://config"'),
				"unknown rendered inside its own block",
			);
			assert.ok(user.includes("which database adapter"));
			assert.ok(
				!system.includes("<unknown "),
				"unknown not rendered inside <context>",
			);
			assert.ok(
				!system.includes("<unknowns>"),
				"no separate <unknowns> block",
			);
		});

		it("prompt element carries tokenUsage and tokensFree attrs", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "prompt://1",
					scheme: "prompt",
					fidelity: "promoted",
					body: "Build it",
					tokens: 2,
					attributes: JSON.stringify({ mode: "act" }),
					category: "prompt",
					source_turn: 1,
				},
			];
			const messages = await ContextAssembler.assembleFromTurnContext(
				rows,
				{ systemPrompt: "sys", contextSize: 32768 },
				hooks,
			);
			const user = messages[1].content;

			assert.ok(
				/tokenUsage="\d+"/.test(user),
				"prompt element carries tokenUsage",
			);
			assert.ok(
				/tokensFree="\d+"/.test(user),
				"prompt element carries tokensFree",
			);
		});
	});
});
