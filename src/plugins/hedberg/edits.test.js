import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEditContent } from "./edits.js";

describe("parseEditContent", () => {
	it("returns empty array when no recognized format", () => {
		assert.deepEqual(parseEditContent(""), []);
		assert.deepEqual(parseEditContent("just some text"), []);
	});

	describe("Format 1: merge-conflict SEARCH/REPLACE", () => {
		it("parses single block with 7 marker chars", () => {
			const content = `<<<<<<< SEARCH
old line
=======
new line
>>>>>>> REPLACE`;
			assert.deepEqual(parseEditContent(content), [
				{ search: "old line", replace: "new line" },
			]);
		});

		it("parses multiple blocks", () => {
			const content = `<<<<<<< SEARCH
a
=======
A
>>>>>>> REPLACE
some prose
<<<<<<< SEARCH
b
=======
B
>>>>>>> REPLACE`;
			assert.deepEqual(parseEditContent(content), [
				{ search: "a", replace: "A" },
				{ search: "b", replace: "B" },
			]);
		});

		it("accepts 3-12 marker chars (boundary)", () => {
			for (const n of [3, 5, 12]) {
				const open = "<".repeat(n);
				const sep = "=".repeat(n);
				const close = ">".repeat(n);
				const content = `${open} SEARCH\nx\n${sep}\ny\n${close} REPLACE`;
				assert.deepEqual(
					parseEditContent(content),
					[{ search: "x", replace: "y" }],
					`failed at ${n} markers`,
				);
			}
		});

		it("handles multiline search/replace", () => {
			const content = `<<<<<<< SEARCH
line1
line2
=======
new1
new2
new3
>>>>>>> REPLACE`;
			assert.deepEqual(parseEditContent(content), [
				{ search: "line1\nline2", replace: "new1\nnew2\nnew3" },
			]);
		});
	});

	describe("Format 2: replace-only (no SEARCH header)", () => {
		it("parses replace-only block when no merge-conflict found", () => {
			const content = `=======
new content
>>>>>>> REPLACE`;
			assert.deepEqual(parseEditContent(content), [
				{ search: null, replace: "new content" },
			]);
		});

		it("merge-conflict precedence — replace-only ignored when format 1 matches", () => {
			const content = `<<<<<<< SEARCH
a
=======
A
>>>>>>> REPLACE
=======
orphan
>>>>>>> REPLACE`;
			const result = parseEditContent(content);
			// Format 1 wins — second block is parsed by format 1 too if it matches.
			assert.equal(result.length >= 1, true);
			assert.equal(result[0].search, "a");
			assert.equal(result[0].replace, "A");
		});
	});
});
