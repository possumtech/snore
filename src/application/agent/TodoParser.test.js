import assert from "node:assert";
import test from "node:test";
import TodoParser from "./TodoParser.js";

test("TodoParser", async (t) => {
	await t.test("should parse verb-prefixed todo items", () => {
		const text = `
- [x] read: examine wizard.txt
- [ ] edit: change robe color
- [x] run: verify tests
- [ ] summary: describe changes
`;
		const { list, next } = TodoParser.parse(text);

		assert.strictEqual(list.length, 4);
		assert.strictEqual(list[0].verb, "read");
		assert.strictEqual(list[0].text, "examine wizard.txt");
		assert.strictEqual(list[0].completed, true);
		assert.strictEqual(list[1].verb, "edit");
		assert.strictEqual(list[1].text, "change robe color");
		assert.strictEqual(list[1].completed, false);
		assert.strictEqual(list[2].verb, "run");
		assert.strictEqual(list[3].verb, "summary");

		assert.ok(next);
		assert.strictEqual(next.verb, "edit");
	});

	await t.test("should fall back for lines without verb prefix", () => {
		const text = `
- [x] Completed task
- [ ] Pending task
`;
		const { list } = TodoParser.parse(text);

		assert.strictEqual(list.length, 2);
		assert.strictEqual(list[0].verb, null);
		assert.strictEqual(list[0].text, "Completed task");
		assert.strictEqual(list[0].completed, true);
		assert.strictEqual(list[1].verb, null);
	});

	await t.test("should handle empty input", () => {
		const { list, next } = TodoParser.parse("");
		assert.strictEqual(list.length, 0);
		assert.strictEqual(next, null);
	});

	await t.test("should handle all completed items", () => {
		const text = "- [x] edit: fix bug\n- [X] summary: done";
		const { list, next } = TodoParser.parse(text);
		assert.strictEqual(
			list.every((t) => t.completed),
			true,
		);
		assert.strictEqual(next, null);
	});

	await t.test("should parse verb without colon separator", () => {
		const text = `
- [ ] edit math.js to fix add function
- [x] read math.js
- [ ] summary of changes
`;
		const { list } = TodoParser.parse(text);
		assert.strictEqual(list[0].verb, "edit");
		assert.strictEqual(list[0].text, "math.js to fix add function");
		assert.strictEqual(list[1].verb, "read");
		assert.strictEqual(list[1].text, "math.js");
		assert.strictEqual(list[2].verb, "summary");
		assert.strictEqual(list[2].text, "of changes");
	});

	await t.test("should ignore invalid verb prefixes", () => {
		const text = "- [ ] frobnicate: do something weird";
		const { list } = TodoParser.parse(text);
		assert.strictEqual(list[0].verb, null);
		assert.strictEqual(list[0].text, "frobnicate: do something weird");
	});

	await t.test(
		"crossReference should warn on checked verbs without matching tags",
		() => {
			const todoList = [
				{ verb: "edit", text: "fix bug", completed: true },
				{ verb: "run", text: "test", completed: true },
				{ verb: "read", text: "check file", completed: true },
				{ verb: "summary", text: "done", completed: true },
			];

			const warnings = TodoParser.crossReference(todoList, ["edit"]);
			assert.strictEqual(warnings.length, 1);
			assert.ok(warnings[0].includes("run"));
			assert.ok(warnings[0].includes("no <run> tag"));
		},
	);

	await t.test("crossReference should not warn for unchecked items", () => {
		const todoList = [{ verb: "edit", text: "fix bug", completed: false }];
		const warnings = TodoParser.crossReference(todoList, []);
		assert.strictEqual(warnings.length, 0);
	});

	await t.test("crossReference should skip read/env/summary verbs", () => {
		const todoList = [
			{ verb: "read", text: "check file", completed: true },
			{ verb: "env", text: "get version", completed: true },
			{ verb: "summary", text: "done", completed: true },
		];
		const warnings = TodoParser.crossReference(todoList, []);
		assert.strictEqual(warnings.length, 0);
	});
});
