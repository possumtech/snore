import assert from "node:assert/strict";
import { describe, it } from "node:test";
import HeuristicMatcher from "./matcher.js";

describe("HeuristicMatcher", () => {
	describe("exact match", () => {
		it("replaces an exact match", () => {
			const file = "const x = 1;\nconst y = 2;\nconst z = 3;\n";
			const result = HeuristicMatcher.matchAndPatch(
				"test.js",
				file,
				"const y = 2;",
				"const y = 99;",
			);
			assert.equal(result.error, null);
			assert.equal(result.warning, null);
			assert.ok(result.patch);
			assert.ok(result.newContent.includes("const y = 99;"));
			assert.ok(!result.newContent.includes("const y = 2;"));
		});

		it("warns on multiple exact matches and applies to last", () => {
			const file = "a = 1;\na = 1;\na = 1;\n";
			const result = HeuristicMatcher.matchAndPatch(
				"test.js",
				file,
				"a = 1;",
				"a = 2;",
			);
			assert.equal(result.error, null);
			assert.ok(result.warning);
			assert.ok(result.warning.includes("matched"));
			assert.equal(result.newContent, "a = 1;\na = 1;\na = 2;\n");
		});
	});

	describe("fuzzy match", () => {
		it("matches despite whitespace differences", () => {
			const file = "\tconst x = 1;\n\tconst y = 2;\n\tconst z = 3;\n";
			const result = HeuristicMatcher.matchAndPatch(
				"test.js",
				file,
				"const y = 2;",
				"const y = 99;",
			);
			assert.equal(result.error, null);
			assert.ok(result.patch);
			assert.ok(result.newContent.includes("const y = 99;"));
		});

		it("returns error when no match found", () => {
			const file = "const x = 1;\n";
			const result = HeuristicMatcher.matchAndPatch(
				"test.js",
				file,
				"const y = 999;",
				"const y = 0;",
			);
			assert.ok(result.error);
			assert.equal(result.patch, null);
		});

		it("warns on multiple fuzzy matches", () => {
			const file = "\ta = 1;\n\tb = 2;\n\ta = 1;\n\tc = 3;\n";
			const result = HeuristicMatcher.matchAndPatch(
				"test.js",
				file,
				"a = 1;",
				"a = 99;",
			);
			assert.equal(result.error, null);
			assert.ok(result.warning);
			assert.ok(result.warning.includes("matched"));
		});

		it("skips blank lines during matching", () => {
			const file = "function foo() {\n\n\treturn 1;\n}\n";
			const result = HeuristicMatcher.matchAndPatch(
				"test.js",
				file,
				"function foo() {\nreturn 1;\n}",
				"function foo() {\nreturn 2;\n}",
			);
			assert.equal(result.error, null);
			assert.ok(result.newContent.includes("return 2;"));
		});
	});

	describe("indentation healing", () => {
		it("heals indentation from search to file style", () => {
			const file = "\t\tconst x = 1;\n\t\tconst y = 2;\n";
			const result = HeuristicMatcher.matchAndPatch(
				"test.js",
				file,
				"const y = 2;",
				"const y = 99;",
			);
			assert.equal(result.error, null);
			assert.ok(result.warning);
			assert.ok(result.warning.includes("Indentation healing"));
			assert.ok(result.newContent.includes("\t\tconst y = 99;"));
		});

		it("preserves relative indentation in replace block", () => {
			const file = "    if (x) {\n        return 1;\n    }\n";
			const result = HeuristicMatcher.matchAndPatch(
				"test.js",
				file,
				"if (x) {\n    return 1;\n}",
				"if (x) {\n    return 2;\n    return 3;\n}",
			);
			assert.equal(result.error, null);
			assert.ok(result.newContent.includes("    return 2;"));
		});
	});

	describe("empty search", () => {
		it("appends to end of file on empty search tokens", () => {
			const file = "line1\n   \nline2\n";
			const result = HeuristicMatcher.matchAndPatch(
				"test.js",
				file,
				"   ",
				"line3",
			);
			assert.equal(result.error, null);
			assert.ok(result.newContent.includes("line3"));
		});

		it("adds newline before append if file lacks trailing newline", () => {
			const file = "line1";
			const result = HeuristicMatcher.matchAndPatch(
				"test.js",
				file,
				"  ",
				"line2",
			);
			assert.equal(result.error, null);
			assert.ok(result.newContent.includes("line1\nline2"));
		});
	});
});
