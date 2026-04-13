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
					fidelity: "full",
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
					fidelity: "full",
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
					fidelity: "full",
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
					fidelity: "full",
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
					fidelity: "full",
					state: "read",
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
			const performedPos = user.indexOf("<performed>");
			const progressPos = user.indexOf("<progress");
			const promptPos = user.indexOf("<prompt");
			assert.ok(performedPos < progressPos, "performed before progress");
			assert.ok(progressPos < promptPos, "progress before prompt");
			assert.ok(user.endsWith("</prompt>"), "prompt is last");
		});

		it("splits history into previous and performed by loop boundary", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "get://old.js",
					scheme: "get",
					fidelity: "full",
					state: "read",
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
					fidelity: "full",
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
					fidelity: "full",
					state: "read",
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
			assert.ok(system.includes("<previous>"), "system has previous");
			assert.ok(system.includes("old.js"), "old get in previous");
			assert.ok(!system.includes("new.js"), "new get not in previous");
			assert.ok(user.includes("<performed>"), "user has performed");
			assert.ok(user.includes("new.js"), "new get in performed");
			assert.ok(!user.includes("old.js"), "old get not in performed");
		});

		it("omits previous on first loop", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "prompt://1",
					scheme: "prompt",
					fidelity: "full",
					body: "Do the thing",
					tokens: 3,
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

			assert.ok(!messages[0].content.includes("<previous>"));
		});

		it("renders results with status symbols in performed", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "prompt://1",
					scheme: "prompt",
					fidelity: "full",
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
					fidelity: "full",
					status: 200,
					body: "",
					tokens: 0,
					attributes: JSON.stringify({ file: "app.js" }),
					category: "logging",
					source_turn: 1,
				},
				{
					ordinal: 3,
					path: "summarize://done",
					scheme: "summarize",
					fidelity: "full",
					status: 200,
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
			assert.ok(user.includes("<performed>"), "results in performed block");
			assert.ok(
				user.includes("<set path="),
				"tool tags in performed use tool name",
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
			assert.ok(messages[1].content.includes("<progress"));
		});

		it("renders known entries in row order", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "src/app.js",
					scheme: null,
					fidelity: "full",
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
					fidelity: "full",
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
					fidelity: "full",
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

		it("renders unknowns in system message", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "unknown://config",
					scheme: "unknown",
					fidelity: "full",
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
					fidelity: "full",
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
			const system = messages[0].content;

			assert.ok(system.includes("<unknowns>"));
			assert.ok(system.includes("which database adapter"));
		});

		it("progress shows token budget", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "prompt://1",
					scheme: "prompt",
					fidelity: "full",
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

			assert.ok(user.includes("token budget"), "progress shows budget info");
		});
	});
});
