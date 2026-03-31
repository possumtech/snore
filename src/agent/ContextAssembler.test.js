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
				context: [{ key: "/:prompt:1", state: "prompt", value: "task" }],
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
						key: "src/app.js",
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
				context: [{ key: "/:known:auth", state: "full", value: "OAuth2 PKCE" }],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("* /:known:auth — OAuth2 PKCE"));
		});

		it("renders stored known as comma list", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ key: "/:known:a", state: "stored", value: "" },
					{ key: "/:known:b", state: "stored", value: "" },
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("/:known:a, /:known:b"));
		});

		it("renders file paths as comma list", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ key: "src/a.js", state: "file:path", value: "" },
					{ key: "src/b.js", state: "file:path", value: "" },
				],
				userMessage: "",
			});
			assert.ok(messages[0].content.includes("src/a.js, src/b.js"));
		});

		it("renders unknowns as bullet list", () => {
			const messages = ContextAssembler.assemble({
				systemPrompt: "sys",
				context: [
					{ key: "/:unknown:1", state: "unknown", value: "which db adapter?" },
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
						key: "/:read:1",
						state: "pass",
						value: "",
						tool: "read",
						target: "src/a.js",
					},
					{
						key: "/:summary:1",
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
						key: "src/utils.js",
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
					{ key: "a.js", state: "file:readonly", value: "x", tokens: 1 },
					{ key: "b.js", state: "file:active", value: "y", tokens: 1 },
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
					{ key: "/:known:x", state: "full", value: "v" },
					{ key: "/:prompt:1", state: "prompt", value: "Do the thing" },
				],
				userMessage: "",
			});
			const content = messages[0].content;
			const knowledgePos = content.indexOf("Knowledge");
			const promptPos = content.indexOf("Do the thing");
			assert.ok(promptPos > knowledgePos);
		});
	});
});
