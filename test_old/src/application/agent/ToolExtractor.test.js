import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import ToolExtractor from "./ToolExtractor.js";

const base = { todo: [], known: [], unknown: [], summary: "" };

describe("ToolExtractor", () => {
	const extractor = new ToolExtractor();

	it("should extract read and drop from todo", () => {
		const { tools } = extractor.extract({
			...base,
			todo: [
				{ tool: "read", argument: "src/a.js", description: "check" },
				{ tool: "drop", argument: "src/b.js", description: "irrelevant" },
			],
		});
		strictEqual(tools.length, 2);
		deepStrictEqual(tools[0], { tool: "read", path: "src/a.js" });
		deepStrictEqual(tools[1], { tool: "drop", path: "src/b.js" });
	});

	it("should extract env and run from todo", () => {
		const { tools } = extractor.extract({
			...base,
			todo: [
				{ tool: "env", argument: "ls -la", description: "list" },
				{ tool: "run", argument: "npm test", description: "test" },
			],
		});
		strictEqual(tools.length, 2);
		deepStrictEqual(tools[0], { tool: "env", command: "ls -la" });
		deepStrictEqual(tools[1], { tool: "run", command: "npm test" });
	});

	it("should extract delete from todo", () => {
		const { tools } = extractor.extract({
			...base,
			todo: [{ tool: "delete", argument: "old.js", description: "remove" }],
		});
		deepStrictEqual(tools[0], { tool: "delete", path: "old.js" });
	});

	it("should skip todo items without tool", () => {
		const { tools } = extractor.extract({
			...base,
			todo: [{ argument: "src/a.js", description: "no tool" }],
		});
		strictEqual(tools.length, 0);
	});

	it("should extract edit from edits array", () => {
		const { tools } = extractor.extract({
			...base,
			edits: [{ file: "src/a.js", search: "old", replace: "new" }],
		});
		strictEqual(tools.length, 1);
		deepStrictEqual(tools[0], {
			tool: "edit",
			path: "src/a.js",
			search: "old",
			replace: "new",
		});
	});

	it("should extract create when search is omitted", () => {
		const { tools } = extractor.extract({
			...base,
			edits: [{ file: "new.js", replace: "content" }],
		});
		strictEqual(tools.length, 1);
		deepStrictEqual(tools[0], {
			tool: "create",
			path: "new.js",
			content: "content",
		});
	});

	it("should skip edits without file", () => {
		const { tools } = extractor.extract({
			...base,
			edits: [{ search: "old", replace: "new" }],
		});
		strictEqual(tools.length, 0);
	});

	it("should extract prompt_user from prompt object", () => {
		const { tools } = extractor.extract({
			...base,
			prompt: { question: "Which?", options: ["A", "B"] },
		});
		strictEqual(tools.length, 1);
		strictEqual(tools[0].tool, "prompt_user");
		strictEqual(tools[0].config.question, "Which?");
		strictEqual(tools[0].config.options.length, 2);
	});

	it("should set hasAct for act tools", () => {
		const { flags } = extractor.extract({
			...base,
			edits: [{ file: "a.js", search: "x", replace: "y" }],
		});
		strictEqual(flags.hasAct, true);
	});

	it("should not set hasAct for read-only tools", () => {
		const { flags } = extractor.extract({
			...base,
			todo: [{ tool: "read", argument: "a.js", description: "read" }],
		});
		strictEqual(flags.hasAct, false);
	});

	it("should set hasReads when read tools present", () => {
		const { flags } = extractor.extract({
			...base,
			todo: [{ tool: "read", argument: "a.js", description: "r" }],
		});
		strictEqual(flags.hasReads, true);
	});

	it("should handle valid input with empty arrays", () => {
		const { tools, flags } = extractor.extract(base);
		strictEqual(tools.length, 0);
		strictEqual(flags.hasAct, false);
		strictEqual(flags.hasReads, false);
	});
});
