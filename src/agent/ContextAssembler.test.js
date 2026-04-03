import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ContextAssembler from "./ContextAssembler.js";

describe("ContextAssembler", () => {
	describe("assembleFromTurnContext", () => {
		it("renders system prompt + context + progress", () => {
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
				},
				{
					ordinal: 3,
					path: "progress://2",
					scheme: "progress",
					fidelity: "full",
					body: "Turn 2/15",
					tokens: 3,
					attributes: null,
					category: "prompt",
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
			assert.ok(messages[0].content.includes("<context>"));
			assert.strictEqual(messages[1].role, "user");
			assert.ok(messages[1].content.includes('<progress tools="'));
			assert.ok(messages[1].content.includes("Turn 2/15"));
		});

		it("uses user scheme as prompt in user message", () => {
			const rows = [
				{
					ordinal: 1,
					path: "ask://1",
					scheme: "ask",
					fidelity: "full",
					body: "User prompt",
					tokens: 3,
					attributes: null,
					category: "prompt",
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});

			assert.strictEqual(messages.length, 2);
			assert.ok(messages[1].role, "user");
			assert.ok(messages[1].content.includes('<ask tools="'));
			assert.ok(messages[1].content.includes("User prompt"));
		});

		it("renders results with status symbols", () => {
			const rows = [
				{
					ordinal: 1,
					path: "edit://1",
					scheme: "edit",
					fidelity: "full",
					state: "pass",
					body: "",
					tokens: 0,
					attributes: JSON.stringify({ file: "app.js" }),
					category: "result",
				},
				{
					ordinal: 2,
					path: "summary://1",
					scheme: "summary",
					fidelity: "full",
					state: "summary",
					body: "Fixed it",
					tokens: 2,
					attributes: null,
					category: "result",
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});
			assert.strictEqual(messages.length, 2);
			const userContent = messages[1].content;

			assert.ok(
				userContent.includes("✓"),
				"pass result should have check mark",
			);
			assert.ok(
				userContent.includes("summary: Fixed it"),
				"summary should render",
			);
			assert.ok(
				userContent.includes("<messages>"),
				"results in messages block",
			);
		});

		it("renders empty context when no entries", () => {
			const rows = [];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});

			assert.strictEqual(messages.length, 2);
			assert.strictEqual(messages[0].content, "sys");
			assert.strictEqual(messages[1].role, "user");
		});

		it("renders index fidelity for files and stored known", () => {
			const rows = [
				{
					ordinal: 1,
					path: "src/utils.js",
					scheme: null,
					fidelity: "index",
					body: "",
					tokens: 0,
					attributes: null,
					category: "file_index",
				},
				{
					ordinal: 2,
					path: "known://old",
					scheme: "known",
					fidelity: "index",
					body: "",
					tokens: 0,
					attributes: null,
					category: "known_index",
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows, {
				systemPrompt: "sys",
			});
			const content = messages[0].content;

			assert.ok(content.includes("Index"), "index files render as Index");
			assert.ok(content.includes("src/utils.js"));
			assert.ok(content.includes("Stored"), "index known renders as Stored");
			assert.ok(content.includes("known://old"));
		});
	});
});
