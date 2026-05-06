import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSed } from "./sed.js";

describe("parseSed", () => {
	it("returns null for non-sed input", () => {
		assert.equal(parseSed("not sed"), null);
		assert.equal(parseSed(""), null);
		assert.equal(parseSed("foo/bar"), null);
	});

	it("rejects sed with alphanumeric delimiter", () => {
		// "sa..." would have delimiter 'a', which is alphanumeric.
		assert.equal(parseSed("saooaiia"), null);
	});

	it("parses simple s/search/replace/", () => {
		const blocks = parseSed("s/foo/bar/");
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].search, "foo");
		assert.equal(blocks[0].replace, "bar");
		assert.equal(blocks[0].flags, "");
		assert.equal(blocks[0].sed, true);
	});

	it("captures gim flags suffix", () => {
		// `s` and `v` from real sed are not recognized: `s` collides with
		// chained `s<delim>` after whitespace, and neither has effect on
		// our literal substring substitution.
		assert.equal(parseSed("s/a/b/g")[0].flags, "g");
		assert.equal(parseSed("s/a/b/gi")[0].flags, "gi");
		assert.equal(parseSed("s/a/b/gim")[0].flags, "gim");
	});

	it("supports alternative delimiters (|, #, ,)", () => {
		assert.equal(parseSed("s|foo|bar|")[0].search, "foo");
		assert.equal(parseSed("s#foo#bar#")[0].search, "foo");
		assert.equal(parseSed("s,a,b,")[0].search, "a");
	});

	it("unescapes the chosen delimiter inside parts", () => {
		const blocks = parseSed("s/a\\/b/c/");
		assert.equal(blocks[0].search, "a/b");
	});

	it("parses chained s/a/b/;s/c/d/ into multiple blocks", () => {
		const blocks = parseSed("s/a/b/g s/c/d/");
		assert.equal(blocks.length, 2);
		assert.equal(blocks[0].search, "a");
		assert.equal(blocks[0].flags, "g");
		assert.equal(blocks[1].search, "c");
	});

	it("returns null when the s expression is unterminated (no second delim)", () => {
		assert.equal(parseSed("s/foo"), null);
	});

	it("throws on malformed sed (unescaped delimiter in SEARCH/REPLACE)", () => {
		// `./executable` contains `/`; the sed parser sees `/` as the
		// delimiter, so the SEARCH gets truncated at the first internal
		// slash. Refuse rather than silently corrupt the target.
		assert.throws(
			() => parseSed("s/- [ ] Run `./executable`/- [x] Run `./executable`/g"),
			/Malformed sed/,
		);
	});

	it("alternative delimiters allow content containing `/`", () => {
		const blocks = parseSed(
			"s,- [ ] Run `./executable`,- [x] Run `./executable`,g",
		);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].search, "- [ ] Run `./executable`");
		assert.equal(blocks[0].replace, "- [x] Run `./executable`");
		assert.equal(blocks[0].flags, "g");
	});

	// Multi-line layout: the model often spreads long substitutions across
	// lines for readability. The parser tolerates whitespace before flags.
	describe("multi-line layout", () => {
		it("tolerates whitespace before flags", () => {
			const blocks = parseSed("s|a|b|\ng");
			assert.equal(blocks.length, 1);
			assert.equal(blocks[0].flags, "g");
		});

		it("tolerates whitespace+newline before flags after long replace", () => {
			const blocks = parseSed(
				"s|- [ ] Impl: flags|- [x] Impl: flags (tested)|\n  g",
			);
			assert.equal(blocks.length, 1);
			assert.equal(blocks[0].search, "- [ ] Impl: flags");
			assert.equal(blocks[0].replace, "- [x] Impl: flags (tested)");
			assert.equal(blocks[0].flags, "g");
		});

		it("preserves intentional whitespace inside search/replace fields", () => {
			// Whitespace BEFORE flags is stripped; whitespace INSIDE
			// search/replace stays — including a leading newline that the
			// model may not have intended (caveat documented in README).
			const blocks = parseSed("s|x|\ny|g");
			assert.equal(blocks[0].search, "x");
			assert.equal(blocks[0].replace, "\ny");
		});

		it("does not eat 's' as a flag when followed by a chain", () => {
			// `s` is intentionally NOT a recognized flag (would collide
			// with the next chained `s<delim>` command after whitespace).
			const blocks = parseSed("s|a|b| s|c|d|");
			assert.equal(blocks.length, 2);
			assert.equal(blocks[0].flags, "");
			assert.equal(blocks[1].search, "c");
		});
	});
});
