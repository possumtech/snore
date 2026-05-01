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

	describe("Format 3: unified diff", () => {
		it("parses hunks with - and + lines", () => {
			const content = `@@ -1,3 +1,3 @@
 unchanged
-removed
+added`;
			const blocks = parseEditContent(content);
			assert.equal(blocks.length, 1);
			assert.equal(blocks[0].search, "unchanged\nremoved");
			assert.equal(blocks[0].replace, "unchanged\nadded");
		});

		it("only triggers when both @@ marker and -/+ lines present", () => {
			// Has @@ but no -/+ lines after newline.
			assert.deepEqual(parseEditContent("@@ context @@\nplain text"), []);
		});

		it("handles multiple hunks", () => {
			const content = `@@ -1 +1 @@
-a
+A
@@ -5 +5 @@
-b
+B`;
			const blocks = parseEditContent(content);
			assert.equal(blocks.length, 2);
			assert.equal(blocks[0].search, "a");
			assert.equal(blocks[0].replace, "A");
			assert.equal(blocks[1].search, "b");
			assert.equal(blocks[1].replace, "B");
		});

		it("skips empty hunks", () => {
			const content = "@@ -1 +1 @@\n@@ -5 +5 @@\n-a\n+A";
			const blocks = parseEditContent(content);
			// Only the second hunk has content.
			assert.equal(blocks.length, 1);
		});
	});

	describe("Format 4: Claude XML <old_text>/<new_text>", () => {
		it("parses single block", () => {
			const content =
				"<old_text>removed</old_text>\n<new_text>added</new_text>";
			assert.deepEqual(parseEditContent(content), [
				{ search: "removed", replace: "added" },
			]);
		});

		it("parses multiple blocks separated by whitespace", () => {
			const content = `<old_text>a</old_text><new_text>A</new_text>
<old_text>b</old_text><new_text>B</new_text>`;
			assert.deepEqual(parseEditContent(content), [
				{ search: "a", replace: "A" },
				{ search: "b", replace: "B" },
			]);
		});

		it("only triggers as fallback after formats 1/2/3 don't match", () => {
			const mixed = `<<<<<<< SEARCH
x
=======
y
>>>>>>> REPLACE
<old_text>old</old_text><new_text>new</new_text>`;
			// Format 1 matches → format 4 ignored.
			const blocks = parseEditContent(mixed);
			assert.equal(blocks.length, 1);
			assert.equal(blocks[0].search, "x");
		});
	});
});
