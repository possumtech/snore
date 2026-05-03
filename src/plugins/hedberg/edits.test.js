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

	describe("Empty SEARCH (creation form)", () => {
		it("parses block with empty SEARCH section as a create", () => {
			const content = `<<<<<<< SEARCH
=======
new file contents
>>>>>>> REPLACE`;
			assert.deepEqual(parseEditContent(content), [
				{ search: "", replace: "new file contents" },
			]);
		});

		it("accepts a blank line between SEARCH and the separator", () => {
			const content = `<<<<<<< SEARCH

=======
new file contents
>>>>>>> REPLACE`;
			assert.deepEqual(parseEditContent(content), [
				{ search: "", replace: "new file contents" },
			]);
		});

		it("multiline replace in creation form", () => {
			const content = `<<<<<<< SEARCH
=======
line one
line two
line three
>>>>>>> REPLACE`;
			assert.deepEqual(parseEditContent(content), [
				{ search: "", replace: "line one\nline two\nline three" },
			]);
		});
	});
});
