import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ContextAssembler from "./ContextAssembler.js";

describe("ContextAssembler", () => {
	describe("assemble", () => {
		it("puts system prompt in system message", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "You are helpful.",
				context: [],
				userMessage: "hello",
			});
			assert.equal(messages[0].role, "system");
			assert.ok(messages[0].content.includes("You are helpful."));
		});

		it("adds user message when no prompt in context", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [],
				userMessage: "hello",
			});
			assert.equal(messages.length, 2);
			assert.equal(messages[1].role, "user");
			assert.equal(messages[1].content, "hello");
		});

		it("omits user message when prompt exists in context", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [{ path: "/:prompt:1", state: "prompt", body: "task" }],
				userMessage: "hello",
			});
			assert.equal(messages.length, 1);
		});
	});

	describe("context rendering", () => {
		it("renders files as code fences", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{
						path: "src/app.js",
						state: "file",
						body: "const x = 1;",
						tokens: 5,
					},
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("```js"));
			assert.ok(messages[0].content.includes("const x = 1;"));
			assert.ok(messages[0].content.includes("(5 tokens)"));
		});

		it("renders active known as bullet list", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [{ path: "/:known:auth", state: "full", body: "OAuth2 PKCE" }],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("* /:known:auth — OAuth2 PKCE"));
		});

		it("renders stored known as comma list", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ path: "/:known:a", state: "stored", body: "" },
					{ path: "/:known:b", state: "stored", body: "" },
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("/:known:a, /:known:b"));
		});

		it("renders file paths as comma list", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ path: "src/a.js", state: "file:path", body: "" },
					{ path: "src/b.js", state: "file:path", body: "" },
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("src/a.js, src/b.js"));
		});

		it("renders unknowns as bullet list", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ path: "/:unknown:1", state: "unknown", body: "which db adapter?" },
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("* which db adapter?"));
		});

		it("renders results with check marks", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{
						path: "/:read:1",
						state: "pass",
						body: "",
						tool: "read",
						target: "src/a.js",
					},
					{
						path: "/:summary:1",
						state: "summary",
						body: "Did stuff.",
						tool: "summary",
						target: "",
					},
				],
				userMessage: "",
			});
			const content = messages[0].content;
			assert.ok(content.includes("read src/a.js ✓"));
			assert.ok(content.includes("summary: Did stuff."));
		});

		it("renders symbol files", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{
						path: "src/utils.js",
						state: "file:summary",
						body: "foo(a, b)\nbar()",
					},
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("(summary)"));
			assert.ok(messages[0].content.includes("foo(a, b)"));
		});

		it("renders readonly and active file labels", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ path: "a.js", state: "file:readonly", body: "x", tokens: 1 },
					{ path: "b.js", state: "file:active", body: "y", tokens: 1 },
				],
				userMessage: "",
			});
			const content = messages[0].content;
			assert.ok(content.includes("(readonly)"));
			assert.ok(content.includes("(active)"));
		});

		it("renders prompt at the end", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ path: "/:known:x", state: "full", body: "v" },
					{ path: "/:prompt:1", state: "prompt", body: "Do the thing" },
				],
				userMessage: "",
			});
			const content = messages[0].content;
			const knowledgePos = content.indexOf("Knowledge");
			const promptPos = content.indexOf("Do the thing");
			assert.ok(promptPos > knowledgePos);
		});
	});

	describe("assembleFromTurnContext", () => {
		it("renders system prompt + context + continuation", () => {
			const rows = [
				{
					ordinal: 0,
					path: "system://prompt",
					scheme: "system",
					fidelity: "full",
					body: "You are helpful.",
					tokens: 5,
					attributes: null,
				},
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
			const messages = ContextAssembler.assembleFromTurnContext(rows);

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
					ordinal: 0,
					path: "system://prompt",
					scheme: "system",
					fidelity: "full",
					body: "sys",
					tokens: 1,
					attributes: null,
				},
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
			const messages = ContextAssembler.assembleFromTurnContext(rows);

			assert.strictEqual(messages.length, 2);
			assert.ok(messages[1].role, "user");
			assert.ok(messages[1].content.includes('<ask tools="'));
			assert.ok(messages[1].content.includes("User prompt"));
		});

		it("renders results with status symbols", () => {
			const rows = [
				{
					ordinal: 0,
					path: "system://prompt",
					scheme: "system",
					fidelity: "full",
					body: "sys",
					tokens: 1,
					attributes: null,
				},
				{
					ordinal: 1,
					path: "edit://1",
					scheme: "edit",
					fidelity: "full",
					body: "",
					tokens: 0,
					attributes: JSON.stringify({
						tool: "edit",
						target: "app.js",
						state: "pass",
					}),
					category: "result",
				},
				{
					ordinal: 2,
					path: "summary://1",
					scheme: "summary",
					fidelity: "full",
					body: "Fixed it",
					tokens: 2,
					attributes: JSON.stringify({
						tool: "summary",
						target: "",
						state: "summary",
					}),
					category: "result",
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows);
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
			const rows = [
				{
					ordinal: 0,
					path: "system://prompt",
					scheme: "system",
					fidelity: "full",
					body: "sys",
					tokens: 1,
					attributes: null,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows);

			assert.strictEqual(messages.length, 2);
			assert.strictEqual(messages[0].content, "sys");
			assert.strictEqual(messages[1].role, "user");
		});

		it("renders index fidelity for files and stored known", () => {
			const rows = [
				{
					ordinal: 0,
					path: "system://prompt",
					scheme: "system",
					fidelity: "full",
					body: "sys",
					tokens: 1,
					attributes: null,
				},
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
			const messages = ContextAssembler.assembleFromTurnContext(rows);
			const content = messages[0].content;

			assert.ok(
				content.includes("File Index"),
				"index files render as File Index",
			);
			assert.ok(content.includes("src/utils.js"));
			assert.ok(content.includes("Stored"), "index known renders as Stored");
			assert.ok(content.includes("known://old"));
		});
	});
});
