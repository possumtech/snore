import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ToolExtractor from "../../src/application/agent/ToolExtractor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const askSchema = JSON.parse(
	readFileSync(join(__dirname, "../../src/domain/schema/ask.json"), "utf8"),
);
const actSchema = JSON.parse(
	readFileSync(join(__dirname, "../../src/domain/schema/act.json"), "utf8"),
);

test("§6 Rumsfeld Loop — schema and tool extraction", async (t) => {
	await t.test("ask schema requires only summary", () => {
		assert.deepStrictEqual(askSchema.required, ["summary"]);
	});

	await t.test("act schema requires only summary", () => {
		assert.deepStrictEqual(actSchema.required, ["summary"]);
	});

	await t.test("ask tool enum is read, drop, env", () => {
		const toolEnum = askSchema.properties.todo.items.properties.tool.enum;
		assert.deepStrictEqual(toolEnum.sort(), ["drop", "env", "read"]);
	});

	await t.test("act tool enum includes delete and run", () => {
		const toolEnum = actSchema.properties.todo.items.properties.tool.enum;
		assert.ok(toolEnum.includes("delete"));
		assert.ok(toolEnum.includes("run"));
		assert.ok(toolEnum.includes("read"));
		assert.ok(toolEnum.includes("env"));
	});

	await t.test("act schema has edits array", () => {
		assert.ok(actSchema.properties.edits, "act schema should have edits");
		assert.strictEqual(actSchema.properties.edits.type, "array");
		const editProps = actSchema.properties.edits.items.properties;
		assert.ok(editProps.file, "edit needs file");
		assert.ok(editProps.search !== undefined, "edit needs search");
		assert.ok(editProps.replace, "edit needs replace");
	});

	await t.test("ask schema does NOT have edits", () => {
		assert.strictEqual(actSchema.properties.edits !== undefined, true);
		assert.strictEqual(
			askSchema.properties.edits,
			undefined,
			"ask should not have edits",
		);
	});

	await t.test("ToolExtractor routes empty search to create", () => {
		const extractor = new ToolExtractor();
		const { tools } = extractor.extract({
			todo: [],
			known: [],
			unknown: [],
			summary: "",
			edits: [{ file: "new.md", search: "", replace: "# Hello" }],
		});
		assert.strictEqual(tools[0].tool, "create");
		assert.strictEqual(tools[0].content, "# Hello");
	});

	await t.test("summary is a structural field, not a tool", () => {
		const askTools = askSchema.properties.todo.items.properties.tool.enum;
		const actTools = actSchema.properties.todo.items.properties.tool.enum;
		assert.ok(!askTools.includes("summary"), "summary not in ask tools");
		assert.ok(!actTools.includes("summary"), "summary not in act tools");
		assert.ok(askSchema.properties.summary, "summary is a top-level field");
	});

	await t.test("env is a finding tool, same as run", () => {
		const extractor = new ToolExtractor();
		const { tools: envTools } = extractor.extract({
			todo: [{ tool: "env", argument: "ls", description: "list" }],
		});
		const { tools: runTools } = extractor.extract({
			todo: [{ tool: "run", argument: "npm test", description: "test" }],
		});
		// Both produce command-type tools
		assert.strictEqual(envTools[0].tool, "env");
		assert.ok(envTools[0].command, "env has command");
		assert.strictEqual(runTools[0].tool, "run");
		assert.ok(runTools[0].command, "run has command");
	});
});
