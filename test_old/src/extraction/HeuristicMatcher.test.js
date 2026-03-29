import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import HeuristicMatcher from "./HeuristicMatcher.js";

describe("HeuristicMatcher", () => {
	const filePath = "test.js";
	const fileContent = `
function hello() {
  console.log("hello world");
}
`.trim();

	it("should perform an exact match and return a patch", () => {
		const searchBlock = '  console.log("hello world");'; // Match exact indentation in fileContent
		const replaceBlock = '  console.log("hello rummy");';

		const result = HeuristicMatcher.matchAndPatch(
			filePath,
			fileContent,
			searchBlock,
			replaceBlock,
		);

		ok(result.patch);
		strictEqual(result.warning, null);
		strictEqual(result.error, null);
		ok(result.patch.includes('-  console.log("hello world");'));
		ok(result.patch.includes('+  console.log("hello rummy");'));
	});

	it("should heal multiple exact matches by using the last one", () => {
		const content = `
log("hi");
log("hi");
`.trim();
		const searchBlock = 'log("hi");';
		const replaceBlock = 'log("bye");';

		const result = HeuristicMatcher.matchAndPatch(
			filePath,
			content,
			searchBlock,
			replaceBlock,
		);

		ok(result.patch, "Should produce a patch");
		strictEqual(result.error, null);
		ok(result.warning.includes("matched 2 locations"));
		ok(result.patch.includes('+log("bye");'));
	});

	it("should perform a fuzzy match by ignoring whitespace", () => {
		const searchBlock = 'console.log("hello world");'; // No leading spaces
		const replaceBlock = 'console.log("hello fuzzy");';

		const result = HeuristicMatcher.matchAndPatch(
			filePath,
			fileContent,
			searchBlock,
			replaceBlock,
		);

		ok(result.patch);
		strictEqual(result.error, null);
		// Indentation should be healed to match the file's 2 spaces
		ok(result.patch.includes('-  console.log("hello world");'));
		ok(result.patch.includes('+  console.log("hello fuzzy");'));
	});

	it("should heal indentation if it differs", () => {
		const searchBlock = '  console.log("hello world");'; // 2 spaces
		const replaceBlock = '  console.log("line 1");\n  console.log("line 2");';

		const contentWithTabs = '\tconsole.log("hello world");';
		const result = HeuristicMatcher.matchAndPatch(
			filePath,
			contentWithTabs,
			searchBlock,
			replaceBlock,
		);

		ok(result.patch);
		ok(result.warning.includes("Indentation healing applied"));
		// Check if it used tabs in the replacement
		ok(result.patch.includes('+\tconsole.log("line 1");'));
		ok(result.patch.includes('+\tconsole.log("line 2");'));
	});

	it("should fail if search block is empty", () => {
		const result = HeuristicMatcher.matchAndPatch(
			filePath,
			fileContent,
			"   ",
			"something",
		);

		ok(result.patch, "Empty search should append to end of file");
		ok(
			result.patch.includes("+something"),
			"Patch should contain appended content",
		);
		strictEqual(result.error, null);
	});

	it("should fail if no match is found", () => {
		const result = HeuristicMatcher.matchAndPatch(
			filePath,
			fileContent,
			"non-existent",
			"something",
		);

		strictEqual(result.patch, null);
		ok(result.error.includes("Could not find the SEARCH block"));
	});

	it("should heal multiple fuzzy matches by using the last one", () => {
		const content = "function a() { return 1; }\nfunction a() { return 1; }";
		const searchBlock = "function a() { return 1; }";
		const replaceBlock = "function a() { return 2; }";

		const result = HeuristicMatcher.matchAndPatch(
			filePath,
			content,
			searchBlock,
			replaceBlock,
		);

		ok(result.patch, "Should produce a patch");
		strictEqual(result.error, null);
		ok(result.warning.includes("matched 2 locations"));
		ok(result.patch.includes("+function a() { return 2; }"));
	});

	it("should perform a fuzzy match skipping blank lines in target file", () => {
		const content = `
function hello() {

  console.log("hello world");

}
`.trim();
		const searchBlock = 'function hello() {\n  console.log("hello world");\n}';
		const replaceBlock = 'function hello() {\n  console.log("hello fuzzy");\n}';

		const result = HeuristicMatcher.matchAndPatch(
			filePath,
			content,
			searchBlock,
			replaceBlock,
		);

		if (!result.patch) console.log("Fuzzy Match Error:", result.error);
		ok(result.patch);
		strictEqual(result.error, null);
		ok(result.patch.includes('-  console.log("hello world");'));
		ok(result.patch.includes('+  console.log("hello fuzzy");'));
	});

	it("should heal indentation for lines that don't match the searchIndent exactly", () => {
		const content = '    log("hi");'; // 4 spaces
		const searchBlock = '  log("hi");'; // 2 spaces
		const replaceBlock = '  log("line 1");\nnot_indented();';

		const result = HeuristicMatcher.matchAndPatch(
			filePath,
			content,
			searchBlock,
			replaceBlock,
		);

		if (result.patch) console.log("Healed Patch Content:\n", result.patch);
		ok(result.patch);
		// 'not_indented();' should be prepended with the file's 4-space indent
		ok(result.patch.includes("+    not_indented();"));
	});
});
