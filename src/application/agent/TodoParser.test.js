import assert from "node:assert";
import test from "node:test";
import TodoParser from "./TodoParser.js";

test("TodoParser", async (t) => {
	await t.test("should parse tool-prefixed todo items", () => {
		const text = `
- [x] read: AGENTS.md # review project status
- [ ] edit: src/main.js # fix the bug
- [x] run: npm test # verify tests pass
- [ ] summary: Fixed the bug # done
`;
		const { list, next } = TodoParser.parse(text);

		assert.strictEqual(list.length, 4);
		assert.strictEqual(list[0].tool, "read");
		assert.strictEqual(list[0].argument, "AGENTS.md");
		assert.strictEqual(list[0].description, "review project status");
		assert.strictEqual(list[0].completed, true);
		assert.strictEqual(list[1].tool, "edit");
		assert.strictEqual(list[1].argument, "src/main.js");
		assert.strictEqual(list[1].completed, false);
		assert.strictEqual(list[2].tool, "run");
		assert.strictEqual(list[3].tool, "summary");

		assert.ok(next);
		assert.strictEqual(next.tool, "edit");
	});

	await t.test("should fall back for lines without tool prefix", () => {
		const text = `
- [x] Completed task
- [ ] Pending task
`;
		const { list } = TodoParser.parse(text);

		assert.strictEqual(list.length, 2);
		assert.strictEqual(list[0].tool, null);
		assert.strictEqual(list[0].argument, "Completed task");
		assert.strictEqual(list[0].completed, true);
		assert.strictEqual(list[1].tool, null);
	});

	await t.test("should handle empty input", () => {
		const { list, next } = TodoParser.parse("");
		assert.strictEqual(list.length, 0);
		assert.strictEqual(next, null);
	});

	await t.test("should handle all completed items", () => {
		const text = "- [x] edit: fix.js # fix bug\n- [X] summary: done # finished";
		const { list, next } = TodoParser.parse(text);
		assert.strictEqual(
			list.every((t) => t.completed),
			true,
		);
		assert.strictEqual(next, null);
	});

	await t.test("should parse tool without colon separator", () => {
		const text = `
- [ ] edit src/main.js
- [x] read AGENTS.md
- [ ] summary done
`;
		const { list } = TodoParser.parse(text);
		assert.strictEqual(list[0].tool, "edit");
		assert.strictEqual(list[0].argument, "src/main.js");
		assert.strictEqual(list[1].tool, "read");
		assert.strictEqual(list[2].tool, "summary");
	});

	await t.test("should ignore invalid tool names", () => {
		const text = "- [ ] frobnicate: something weird";
		const { list } = TodoParser.parse(text);
		assert.strictEqual(list[0].tool, null);
		assert.strictEqual(list[0].argument, "frobnicate: something weird");
	});

	await t.test("should handle env commands with shell pipes", () => {
		const text = "- [ ] env: cat file.txt | grep error | wc -l # count errors";
		const { list } = TodoParser.parse(text);
		assert.strictEqual(list[0].tool, "env");
		assert.strictEqual(list[0].argument, "cat file.txt | grep error | wc -l");
		assert.strictEqual(list[0].description, "count errors");
	});

});
