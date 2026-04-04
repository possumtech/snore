import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ContextAssembler from "./ContextAssembler.js";

describe("ContextAssembler", () => {
	describe("assembleFromTurnContext", () => {
		it("renders system prompt + knowledge + user prompt", () => {
			const rows = [
				{
					ordinal: 1,
					path: "known://auth",
					scheme: "known",
					fidelity: "full",
					body: "JWT",
					tokens: 1,
					attributes: null,
					category: "known",
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
					category: "file",
					source_turn: 1,
				},
				{
					ordinal: 3,
					path: "ask://1",
					scheme: "ask",
					fidelity: "full",
					body: "What does this do?",
					tokens: 3,
					attributes: null,
					category: "prompt",
					source_turn: 1,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "You are helpful.",
			});

			assert.strictEqual(messages.length, 2);
			assert.strictEqual(messages[0].role, "system");
			assert.ok(messages[0].content.includes("You are helpful."));
			assert.ok(messages[0].content.includes("known://auth"));
			assert.ok(messages[0].content.includes("const x = 1;"));
			assert.ok(messages[0].content.includes("<knowledge>"));
			assert.strictEqual(messages[1].role, "user");
			assert.ok(messages[1].content.includes("<ask"));
			assert.ok(messages[1].content.includes("What does this do?"));
		});

		it("prompt always appears last in user message", () => {
			const rows = [
				{
					ordinal: 1,
					path: "ask://1",
					scheme: "ask",
					fidelity: "full",
					body: "The question",
					tokens: 3,
					attributes: null,
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
					category: "result",
					source_turn: 1,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});

			const user = messages[1].content;
			const currentPos = user.indexOf("<current>");
			const progressPos = user.indexOf("<progress>");
			const askPos = user.indexOf("<ask");
			assert.ok(currentPos < progressPos, "current before progress");
			assert.ok(progressPos < askPos, "progress before ask");
			assert.ok(user.endsWith("</ask>"), "ask is last");
		});

		it("splits history into previous and current by loop boundary", () => {
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
					category: "result",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "ask://3",
					scheme: "ask",
					fidelity: "full",
					body: "New question",
					tokens: 3,
					attributes: null,
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
					category: "result",
					source_turn: 3,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});

			const system = messages[0].content;
			const user = messages[1].content;
			assert.ok(system.includes("<previous>"), "system has previous");
			assert.ok(system.includes("old result"), "old result in previous");
			assert.ok(!system.includes("new result"), "new result not in previous");
			assert.ok(user.includes("<current>"), "user has current");
			assert.ok(user.includes("new result"), "new result in current");
			assert.ok(!user.includes("old result"), "old result not in current");
		});

		it("omits previous on first loop", () => {
			const rows = [
				{
					ordinal: 1,
					path: "act://1",
					scheme: "act",
					fidelity: "full",
					body: "Do the thing",
					tokens: 3,
					attributes: null,
					category: "prompt",
					source_turn: 1,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});

			assert.ok(!messages[0].content.includes("<previous>"));
		});

		it("renders results with status symbols in current", () => {
			const rows = [
				{
					ordinal: 1,
					path: "act://1",
					scheme: "act",
					fidelity: "full",
					body: "Fix it",
					tokens: 2,
					attributes: null,
					category: "prompt",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "set://app.js",
					scheme: "set",
					fidelity: "full",
					state: "pass",
					body: "",
					tokens: 0,
					attributes: JSON.stringify({ file: "app.js" }),
					category: "result",
					source_turn: 1,
				},
				{
					ordinal: 3,
					path: "summarize://done",
					scheme: "summarize",
					fidelity: "full",
					state: "summary",
					body: "Fixed it",
					tokens: 2,
					attributes: null,
					category: "structural",
					source_turn: 1,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});
			const user = messages[1].content;

			assert.ok(user.includes("✓"), "pass result has check mark");
			assert.ok(user.includes("summary: Fixed it"), "summary renders");
			assert.ok(user.includes("<current>"), "results in current block");
		});

		it("renders empty context when no entries", () => {
			const rows = [];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});

			assert.strictEqual(messages.length, 2);
			assert.strictEqual(messages[0].content, "sys");
			assert.strictEqual(messages[1].role, "user");
			assert.ok(messages[1].content.includes("<progress>Begin.</progress>"));
		});

		it("renders knowledge sorted by fidelity then category", () => {
			const rows = [
				{
					ordinal: 1,
					path: "src/app.js",
					scheme: null,
					fidelity: "full",
					body: "const x = 1;",
					tokens: 5,
					attributes: null,
					category: "file",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "src/utils.js",
					scheme: null,
					fidelity: "index",
					body: "",
					tokens: 0,
					attributes: null,
					category: "file_index",
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
					category: "known",
					source_turn: 1,
				},
				{
					ordinal: 4,
					path: "known://old",
					scheme: "known",
					fidelity: "index",
					body: "",
					tokens: 0,
					attributes: null,
					category: "known_index",
					source_turn: 1,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});
			const content = messages[0].content;

			assert.ok(content.includes("<knowledge>"));
			assert.ok(content.includes("src/utils.js"), "index file listed");
			assert.ok(content.includes("known://old"), "index known listed");
			assert.ok(content.includes("const x = 1;"), "full file rendered");
			assert.ok(content.includes("known://auth"), "full known rendered");

			// Index entries appear before full entries
			const indexPos = content.indexOf("src/utils.js");
			const fullPos = content.indexOf("const x = 1;");
			assert.ok(indexPos < fullPos, "index before full");
		});

		it("renders unknowns in system message after previous", () => {
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
					path: "act://1",
					scheme: "act",
					fidelity: "full",
					body: "Do it",
					tokens: 2,
					attributes: null,
					category: "prompt",
					source_turn: 1,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});
			const system = messages[0].content;

			assert.ok(system.includes("<unknowns>"));
			assert.ok(system.includes("which database adapter"));
		});

		it("progress bridges current to prompt", () => {
			const rows = [
				{
					ordinal: 1,
					path: "act://1",
					scheme: "act",
					fidelity: "full",
					body: "Build it",
					tokens: 2,
					attributes: null,
					category: "prompt",
					source_turn: 1,
				},
				{
					ordinal: 2,
					path: "get://file.js",
					scheme: "get",
					fidelity: "full",
					state: "read",
					body: "content",
					tokens: 3,
					attributes: JSON.stringify({ path: "file.js" }),
					category: "result",
					source_turn: 1,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});
			const user = messages[1].content;

			assert.ok(
				user.includes("The above actions were performed"),
				"progress bridges to prompt",
			);
		});
	});
});
