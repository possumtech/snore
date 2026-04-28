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
		it("renders system prompt; known + visible bodies in user", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "known://auth",
					scheme: "known",
					visibility: "visible",
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
					visibility: "visible",
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
					visibility: "visible",
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
			assert.strictEqual(
				messages[0].content,
				"You are helpful.",
				"system holds only the static prompt; <context> moved out",
			);
			assert.strictEqual(messages[1].role, "user");
			const user = messages[1].content;
			assert.ok(user.includes("<summarized>"), "user has <summarized>");
			assert.ok(user.includes("<visible>"), "user has <visible>");
			assert.ok(user.includes("known://auth"), "known summary line");
			assert.ok(user.includes("const x = 1;"), "file body in <visible>");
			assert.ok(user.includes("<prompt"));
			assert.ok(user.includes("What does this do?"));
			assert.ok(
				user.indexOf("<summarized>") < user.indexOf("<visible>"),
				"<summarized> renders above <visible>",
			);
		});

		it("prompt always appears last in user message", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "prompt://1",
					scheme: "prompt",
					visibility: "visible",
					body: "The question",
					tokens: 3,
					attributes: JSON.stringify({ mode: "ask" }),
					category: "prompt",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "log://turn_1/get/file.js",
					scheme: "log",
					visibility: "visible",
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
					path: "log://turn_1/get/old.js",
					scheme: "log",
					visibility: "visible",
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
					visibility: "visible",
					body: "New question",
					tokens: 3,
					attributes: JSON.stringify({ mode: "ask" }),
					category: "prompt",
					source_turn: 3,
				},
				{
					ordinal: 3,
					path: "log://turn_3/get/new.js",
					scheme: "log",
					visibility: "visible",
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
					visibility: "visible",
					body: "Fix it",
					tokens: 2,
					attributes: JSON.stringify({ mode: "act" }),
					category: "prompt",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "log://turn_1/set/app.js",
					scheme: "log",
					visibility: "visible",
					state: "resolved",
					body: "",
					tokens: 0,
					attributes: JSON.stringify({ path: "app.js" }),
					category: "logging",
					source_turn: 1,
				},
				{
					ordinal: 3,
					path: "log://turn_1/update/done",
					scheme: "log",
					visibility: "visible",
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
			assert.ok(user.includes("<set path="), "tool tags in log use tool name");
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

		it("renders data entries in row order in user message", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "src/app.js",
					scheme: null,
					visibility: "visible",
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
					visibility: "visible",
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
					visibility: "visible",
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
			const user = messages[1].content;

			assert.ok(user.includes("<known path="), "known summary line in user");
			assert.ok(user.includes("const y = 2;"), "old file body in <visible>");
			assert.ok(user.includes("JWT"), "known body in <visible>");
			assert.ok(user.includes("const x = 1;"), "new file body in <visible>");
		});

		it("renders unknowns in their own <unknowns> block in the user message", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "unknown://config",
					scheme: "unknown",
					visibility: "visible",
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
					visibility: "visible",
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
				!user.includes("<summarized>") ||
					user.indexOf("<unknowns>") > user.indexOf("<summarized>"),
				"unknowns block does not nest inside <summarized>",
			);
			assert.ok(!system.includes("<unknowns>"), "no <unknowns> in system");
			assert.ok(!system.includes("<unknown "), "no unknowns in system");
		});

		it("prompt element carries tokenUsage and tokensFree attrs", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "prompt://1",
					scheme: "prompt",
					visibility: "visible",
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

		it("summary projection renders as the tag body inside <summarized>", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "src/agent/AgentLoop.js",
					scheme: null,
					visibility: "summarized",
					body: "class AgentLoop { #foo; async start(); }",
					sBody: "class AgentLoop { #foo; async start(); }",
					vBody: "class AgentLoop { #foo; async start() { /* full body */ } }",
					tokens: 12,
					attributes: null,
					category: "data",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "prompt://1",
					scheme: "prompt",
					visibility: "visible",
					body: "Refactor",
					tokens: 1,
					attributes: JSON.stringify({ mode: "ask" }),
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
			const summarizedBlock = user.match(
				/<summarized>([\s\S]*?)<\/summarized>/,
			)?.[1];
			assert.ok(summarizedBlock, "<summarized> block exists");
			assert.ok(
				summarizedBlock.includes("class AgentLoop"),
				"summary projection renders as tag body — symbols visible to model",
			);
			assert.ok(
				summarizedBlock.includes("</file>"),
				"summary entry is a closed tag, not self-closing, when body is present",
			);
		});

		it("visible block renders the full visible projection, summarized block renders the summarized projection", async () => {
			const rows = [
				{
					ordinal: 1,
					path: "known://fact",
					scheme: "known",
					visibility: "visible",
					body: "FULL BODY HERE",
					sBody: "short summary",
					vBody: "FULL BODY HERE",
					attributes: null,
					category: "data",
					source_turn: 2,
				},
				{
					ordinal: 2,
					path: "prompt://1",
					scheme: "prompt",
					visibility: "visible",
					body: "ask",
					attributes: JSON.stringify({ mode: "ask" }),
					category: "prompt",
					source_turn: 2,
				},
			];
			const messages = await ContextAssembler.assembleFromTurnContext(
				rows,
				{ systemPrompt: "sys" },
				hooks,
			);
			const user = messages[1].content;
			const summarizedBlock = user.match(
				/<summarized>([\s\S]*?)<\/summarized>/,
			)?.[1];
			const visibleBlock = user.match(/<visible>([\s\S]*?)<\/visible>/)?.[1];
			assert.ok(summarizedBlock.includes("short summary"));
			assert.ok(!summarizedBlock.includes("FULL BODY HERE"));
			assert.ok(visibleBlock.includes("FULL BODY HERE"));
			assert.ok(!visibleBlock.includes("short summary"));
		});
	});
});
