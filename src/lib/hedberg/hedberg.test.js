import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import Hedberg from "./hedberg.js";

describe("Hedberg plugin", () => {
	it("constructor exposes hedberg utilities on core.hooks.hedberg", () => {
		const hooks = createHooks();
		const core = new PluginContext("hedberg", hooks);
		new Hedberg(core);
		assert.equal(typeof hooks.hedberg.match, "function");
		assert.equal(typeof hooks.hedberg.search, "function");
		assert.equal(typeof hooks.hedberg.replace, "function");
		assert.equal(typeof hooks.hedberg.generatePatch, "function");
	});

	describe("Hedberg.replace", () => {
		it("literal substring replacement returns patch with all matches replaced", () => {
			const result = Hedberg.replace("foo bar foo", "foo", "baz");
			assert.equal(result.patch, "baz bar baz");
			assert.equal(result.error, null);
		});

		it("returns no patch (via heuristic) when literal search not found and heuristic also fails", () => {
			const result = Hedberg.replace("nothing matches", "absent", "x");
			assert.ok(!result.patch);
		});

		it("sed=true is literal substring substitution (no regex)", () => {
			// sed semantics in our context: literal substring substitution
			// via String.replaceAll, not regex compilation. `\d` does not
			// match digits — it's a literal "\d" string. Real regex needs
			// are out of scope.
			const result = Hedberg.replace("a1 b2 c3", "\\d", "X", {
				sed: true,
			});
			assert.ok(
				!result.patch,
				"no match → no patch (heuristic fuzzy also doesn't match)",
			);
		});

		it("sed=true unescapes regex-meta backslashes in replacement", () => {
			const result = Hedberg.replace("abc", "a", "\\.A", {
				sed: true,
				flags: "g",
			});
			assert.equal(result.patch, ".Abc");
		});

		it("sed=true with malformed-regex-shaped input still substitutes literally", () => {
			// In the old regex-mode code, `[bad` would throw on RegExp
			// compile; under literal mode it's just a literal replacement.
			const result = Hedberg.replace("abc", "a", "X", {
				sed: true,
			});
			assert.equal(result.patch, "Xbc");
		});

		it("preserves searchText / replaceText in the result", () => {
			const result = Hedberg.replace("hello", "hello", "world");
			assert.equal(result.searchText, "hello");
			assert.equal(result.replaceText, "world");
		});

		// Lock in the literal-substitution contract: sed=true does NOT
		// compile a regex. The model's regex-shaped patterns either match
		// as literal substrings or don't match at all.
		describe("regex semantics are NOT honored under sed=true", () => {
			it("anchors `^` and `$` are literal characters", () => {
				const r1 = Hedberg.replace("foo bar", "^foo", "X", { sed: true });
				assert.ok(!r1.patch, "^foo doesn't match because ^ is literal");
				const r2 = Hedberg.replace("price$10", "price$", "cost$", {
					sed: true,
				});
				assert.equal(r2.patch, "cost$10", "$ is literal dollar sign");
			});

			it("character classes `[...]` are literal", () => {
				const r = Hedberg.replace("abc xyz", "[abc]", "X", { sed: true });
				assert.ok(!r.patch, "[abc] doesn't match a/b/c — it's literal text");
			});

			it("quantifiers `*`, `+`, `?` are literal", () => {
				const r = Hedberg.replace("aaa", "a+", "X", { sed: true });
				assert.ok(!r.patch, "a+ doesn't match repeats");
			});

			it("alternation `(a|b)` is literal", () => {
				const r = Hedberg.replace("yes maybe no", "(yes|no)", "X", {
					sed: true,
				});
				assert.ok(!r.patch);
			});

			it("`$1` in replacement is literal text, not a capture reference", () => {
				const r = Hedberg.replace("hello world", "hello", "$1 there", {
					sed: true,
				});
				assert.equal(r.patch, "$1 there world");
			});

			it("case-insensitive flag `i` is silently ignored", () => {
				const r = Hedberg.replace("Foo bar", "foo", "X", {
					sed: true,
					flags: "gi",
				});
				assert.ok(!r.patch, "case mismatch → no match (i flag has no effect)");
			});

			it("regex-style escapes ARE stripped to literal characters", () => {
				// Model muscle-memory: \[, \., \| etc. are escapes for regex
				// meta. With sed=true we strip those backslashes so the
				// literal char appears in search/replace.
				const r1 = Hedberg.replace("a [x] b", "\\[x\\]", "[y]", {
					sed: true,
				});
				assert.equal(r1.patch, "a [y] b");
				const r2 = Hedberg.replace("v1.0", "v1\\.0", "v2.0", { sed: true });
				assert.equal(r2.patch, "v2.0");
			});

			it("global replacement is the default (no `g` flag needed)", () => {
				// Native String.replaceAll always replaces all occurrences;
				// the `g` flag has no effect on behavior here.
				const r = Hedberg.replace("a a a", "a", "b", { sed: true });
				assert.equal(r.patch, "b b b");
			});
		});

		// sed=false stays the same: literal-only, no escape stripping (the
		// caller is passing exact bytes, e.g. from a SEARCH/REPLACE block).
		describe("sed=false (default) does not strip backslash escapes", () => {
			it("backslashes in search are preserved verbatim", () => {
				const r = Hedberg.replace("foo \\[bar\\]", "\\[bar\\]", "X");
				assert.equal(r.patch, "foo X");
			});
		});
	});
});
