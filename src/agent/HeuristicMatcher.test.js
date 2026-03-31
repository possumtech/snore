import assert from "node:assert/strict";
import { describe, it } from "node:test";
import HeuristicMatcher from "./HeuristicMatcher.js";

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
	});
});
