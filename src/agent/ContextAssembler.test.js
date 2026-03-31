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
				context: [{ path: "/:prompt:1", state: "prompt", value: "task" }],
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
						value: "const x = 1;",
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
				context: [
					{ path: "/:known:auth", state: "full", value: "OAuth2 PKCE" },
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("* /:known:auth — OAuth2 PKCE"));
		});

		it("renders stored known as comma list", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ path: "/:known:a", state: "stored", value: "" },
					{ path: "/:known:b", state: "stored", value: "" },
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("/:known:a, /:known:b"));
		});

		it("renders file paths as comma list", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ path: "src/a.js", state: "file:path", value: "" },
					{ path: "src/b.js", state: "file:path", value: "" },
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("src/a.js, src/b.js"));
		});

		it("renders unknowns as bullet list", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ path: "/:unknown:1", state: "unknown", value: "which db adapter?" },
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
						value: "",
						tool: "read",
						target: "src/a.js",
					},
					{
						path: "/:summary:1",
						state: "summary",
						value: "Did stuff.",
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
						state: "file:symbols",
						value: "foo(a, b)\nbar()",
					},
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("(symbols)"));
			assert.ok(messages[0].content.includes("foo(a, b)"));
		});

		it("renders readonly and active file labels", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ path: "a.js", state: "file:readonly", value: "x", tokens: 1 },
					{ path: "b.js", state: "file:active", value: "y", tokens: 1 },
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
					{ path: "/:known:x", state: "full", value: "v" },
					{ path: "/:prompt:1", state: "prompt", value: "Do the thing" },
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
					content: "You are helpful.",
					tokens: 5,
					meta: null,
				},
				{
					ordinal: 1,
					path: "known://auth",
					scheme: "known",
					fidelity: "full",
					content: "JWT",
					tokens: 1,
					meta: null,
				},
				{
					ordinal: 2,
					path: "src/app.js",
					scheme: null,
					fidelity: "full",
					content: "const x = 1;",
					tokens: 5,
					meta: null,
				},
				{
					ordinal: 3,
					path: "continuation://prompt",
					scheme: "continuation",
					fidelity: "full",
					content: "Turn 2/15",
					tokens: 3,
					meta: null,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows);

			assert.strictEqual(messages.length, 2);
			assert.strictEqual(messages[0].role, "system");
			assert.ok(messages[0].content.includes("You are helpful."));
			assert.ok(messages[0].content.includes("known://auth"));
			assert.ok(messages[0].content.includes("const x = 1;"));
			assert.strictEqual(messages[1].role, "user");
			assert.strictEqual(messages[1].content, "Turn 2/15");
		});

		it("uses prompt scheme as prompt, not continuation", () => {
			const rows = [
				{
					ordinal: 0,
					path: "system://prompt",
					scheme: "system",
					fidelity: "full",
					content: "sys",
					tokens: 1,
					meta: null,
				},
				{
					ordinal: 1,
					path: "prompt://1",
					scheme: "prompt",
					fidelity: "full",
					content: "User prompt",
					tokens: 3,
					meta: null,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows);

			assert.strictEqual(messages.length, 1);
			assert.ok(messages[0].content.includes("User prompt"));
		});

		it("renders results with status symbols", () => {
			const rows = [
				{
					ordinal: 0,
					path: "system://prompt",
					scheme: "system",
					fidelity: "full",
					content: "sys",
					tokens: 1,
					meta: null,
				},
				{
					ordinal: 1,
					path: "edit://1",
					scheme: "edit",
					fidelity: "full",
					content: "",
					tokens: 0,
					meta: JSON.stringify({
						tool: "edit",
						target: "app.js",
						state: "pass",
					}),
				},
				{
					ordinal: 2,
					path: "summary://1",
					scheme: "summary",
					fidelity: "full",
					content: "Fixed it",
					tokens: 2,
					meta: JSON.stringify({
						tool: "summary",
						target: "",
						state: "summary",
					}),
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows);
			const content = messages[0].content;

			assert.ok(content.includes("✓"), "pass result should have check mark");
			assert.ok(content.includes("summary: Fixed it"), "summary should render");
		});

		it("renders empty context when no entries", () => {
			const rows = [
				{
					ordinal: 0,
					path: "system://prompt",
					scheme: "system",
					fidelity: "full",
					content: "sys",
					tokens: 1,
					meta: null,
				},
			];
			const messages = ContextAssembler.assembleFromTurnContext(rows);

			assert.strictEqual(messages.length, 1);
			assert.strictEqual(messages[0].content, "sys");
		});

		it("renders index fidelity for files and stored known", () => {
			const rows = [
				{
					ordinal: 0,
					path: "system://prompt",
					scheme: "system",
					fidelity: "full",
					content: "sys",
					tokens: 1,
					meta: null,
				},
				{
					ordinal: 1,
					path: "src/utils.js",
					scheme: null,
					fidelity: "index",
					content: "",
					tokens: 0,
					meta: null,
				},
				{
					ordinal: 2,
					path: "known://old",
					scheme: "known",
					fidelity: "index",
					content: "",
					tokens: 0,
					meta: null,
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
