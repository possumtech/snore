import assert from "node:assert";
import test from "node:test";
import ResponseParser from "./ResponseParser.js";

test("ResponseParser", async (t) => {
	const parser = new ResponseParser();

	await t.test("getNodeText should handle mock nodes", () => {
		const node = { isMock: true, childNodes: [{ value: "test content" }] };
		assert.strictEqual(parser.getNodeText(node), "test content");
	});

	await t.test("getNodeText should handle empty mock nodes", () => {
		const node = { isMock: true };
		assert.strictEqual(parser.getNodeText(node), "");
	});

	await t.test(
		"mergePrefill should handle content starting with prefill",
		() => {
			assert.strictEqual(
				parser.mergePrefill("<todo>", "<todo>- [ ]"),
				"<todo>- [ ]",
			);
		},
	);

	await t.test(
		"mergePrefill should prepend prefill for partial completions",
		() => {
			assert.strictEqual(
				parser.mergePrefill("<todo>\n- [", "] task"),
				"<todo>\n- [] task",
			);
			assert.strictEqual(
				parser.mergePrefill("<todo>\n- [", "x] task"),
				"<todo>\n- [x] task",
			);
		},
	);

	await t.test(
		"mergePrefill should prepend prefill if <todo> is missing",
		() => {
			assert.strictEqual(
				parser.mergePrefill("<todo>", "no todo"),
				"<todo>no todo",
			);
		},
	);

	await t.test("parsePromptUser should handle plain text question", () => {
		const node = { isMock: true, childNodes: [{ value: "Simple question?" }] };
		const result = parser.parsePromptUser(node);
		assert.strictEqual(result.question, "Simple question?");
		assert.strictEqual(result.options.length, 1);
		assert.strictEqual(result.options[0].label, "Other");
	});

	await t.test(
		"parsePromptUser should handle question with checklist options",
		() => {
			const node = {
				isMock: true,
				childNodes: [
					{ value: "Choose one:\n- [ ] Opt 1: Desc 1\n- [ ] Opt 2: Desc 2" },
				],
			};
			const result = parser.parsePromptUser(node);
			assert.strictEqual(result.question, "Choose one:");
			assert.strictEqual(result.options.length, 3); // Opt 1, Opt 2, Other
			assert.strictEqual(result.options[0].label, "Opt 1");
			assert.strictEqual(result.options[1].label, "Opt 2");
			assert.strictEqual(result.options[2].label, "Other");
		},
	);

	await t.test("parseActionTags should extract various tags", () => {
		const content = `
			<read file="test.js"/>
			<todo>- [ ] edit: do it</todo>
			<summary>Done</summary>
			<invalid>ignore me</invalid>
		`;
		const tags = parser.parseActionTags(content);
		assert.ok(tags.some((t) => t.tagName === "read"));
		assert.ok(tags.some((t) => t.tagName === "todo"));
		assert.ok(tags.some((t) => t.tagName === "summary"));
		assert.ok(!tags.some((t) => t.tagName === "invalid"));

		const readTag = tags.find((t) => t.tagName === "read");
		assert.strictEqual(
			readTag.attrs.find((a) => a.name === "file").value,
			"test.js",
		);
	});

	await t.test("parseActionTags should handle self-closing tags", () => {
		const content = `<read file="a.js"/><read file="b.js"/>`;
		const tags = parser.parseActionTags(content);
		assert.strictEqual(tags.filter((t) => t.tagName === "read").length, 2);
	});
});
