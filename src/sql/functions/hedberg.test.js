import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hedberg from "./hedberg.js";

describe("hedberg", () => {
	describe("glob patterns", () => {
		it("matches wildcard", () => {
			assert.equal(hedberg("*.js", "index.js"), 1);
			assert.equal(hedberg("*.js", "readme.md"), 0);
		});

		it("matches single char wildcard", () => {
			assert.equal(hedberg("????.ts", "test.ts"), 1);
			assert.equal(hedberg("????.ts", "index.ts"), 0);
		});

		it("matches globstar", () => {
			assert.equal(hedberg("src/**/*.ts", "src/a/b.ts"), 1);
			assert.equal(hedberg("src/**/*.ts", "lib/a.ts"), 0);
		});

		it("matches character class", () => {
			assert.equal(hedberg("[abc]*.js", "alpha.js"), 1);
			assert.equal(hedberg("[abc]*.js", "delta.js"), 0);
		});

		it("handles null string", () => {
			assert.equal(hedberg("*.js", null), 0);
		});
	});

	describe("glob NOT misdetected as regex", () => {
		it("file+name.txt stays glob", () => {
			assert.equal(hedberg("file+name.txt", "file+name.txt"), 1);
			assert.equal(hedberg("file+name.txt", "fileXname.txt"), 0);
		});

		it("c++ stays glob", () => {
			assert.equal(hedberg("c++", "c++"), 1);
		});

		it("parens in path stay glob", () => {
			assert.equal(hedberg("src/utils (copy)/*", "src/utils (copy)/file.js"), 1);
		});

		it("non-numeric brace expansion stays glob", () => {
			assert.equal(hedberg("log{a,b}.txt", "log{a,b}.txt"), 1);
		});
	});

	describe("regex patterns", () => {
		it("detects anchored regex", () => {
			assert.equal(hedberg("^(index|utils)", "index.js"), 1);
			assert.equal(hedberg("^(index|utils)", "readme.md"), 0);
		});

		it("detects escape sequences", () => {
			assert.equal(hedberg("\\.(js|ts)$", "test.ts"), 1);
			assert.equal(hedberg("\\.(js|ts)$", "test.py"), 0);
		});

		it("detects dot-quantifiers", () => {
			assert.equal(hedberg("foo.+bar", "foo123bar"), 1);
			assert.equal(hedberg("foo.*bar", "foobar"), 1);
		});

		it("detects character class escapes", () => {
			assert.equal(hedberg("\\d+", "abc123"), 1);
			assert.equal(hedberg("\\d+", "abcdef"), 0);
		});

		it("detects numeric quantifiers", () => {
			assert.equal(hedberg("a{3}", "aaa"), 1);
			assert.equal(hedberg("a{3}", "aa"), 0);
		});
	});

	describe("regex NOT misdetected as jsonpath", () => {
		it("$.+ is detected as regex not jsonpath", () => {
			// $.+ as regex = end-of-string + one-or-more — never matches
			assert.equal(hedberg("$.+", "anything"), 0);
			// But it must NOT be treated as jsonpath (which would match $.name-like paths)
			assert.equal(hedberg("$.+", '{"name":"test"}'), 0);
		});
	});

	describe("xpath patterns", () => {
		const xml = "<root><item id=\"3\"><name>test</name></item><item id=\"5\"/></root>";

		it("matches //element", () => {
			assert.equal(hedberg("//item", xml), 1);
			assert.equal(hedberg("//missing", xml), 0);
		});

		it("matches //element with attribute predicate", () => {
			assert.equal(hedberg("//item[@id='3']", xml), 1);
			assert.equal(hedberg("//item[@id='99']", xml), 0);
		});

		it("matches absolute path with positional predicate", () => {
			assert.equal(hedberg("/root/item[1]", xml), 1);
		});

		it("matches xpath with function in predicate", () => {
			assert.equal(hedberg("/root/item[position()>1]", xml), 1);
		});

		it("matches xpath with axis", () => {
			assert.equal(hedberg("//item/child::name", xml), 1);
		});

		it("returns 0 for non-XML string", () => {
			assert.equal(hedberg("//div", "just plain text"), 0);
		});
	});

	describe("xpath NOT misdetected", () => {
		it("C++ namespace path stays glob", () => {
			assert.equal(hedberg("/path/to/std::vector.html", "/path/to/std::vector.html"), 1);
		});
	});

	describe("jsonpath patterns", () => {
		const json = JSON.stringify({
			name: "alice",
			items: [{ id: 1 }, { id: 2 }],
			nested: { deep: { value: 42 } },
		});

		it("matches property access", () => {
			assert.equal(hedberg("$.name", json), 1);
		});

		it("matches nested property", () => {
			assert.equal(hedberg("$.nested.deep.value", json), 1);
		});

		it("matches array index", () => {
			assert.equal(hedberg("$.items[0].id", json), 1);
		});

		it("matches array wildcard", () => {
			assert.equal(hedberg("$.items[*].id", json), 1);
		});

		it("matches recursive descent", () => {
			assert.equal(hedberg("$..value", json), 1);
			assert.equal(hedberg("$..missing", json), 0);
		});

		it("returns 0 for missing key", () => {
			assert.equal(hedberg("$.missing", json), 0);
		});

		it("returns 0 for non-JSON string", () => {
			assert.equal(hedberg("$.name", "not json"), 0);
		});
	});

	describe("scheme paths stay glob", () => {
		it("edit:// is glob", () => {
			assert.equal(hedberg("edit://*", "edit://3"), 1);
		});

		it("summary:// is glob", () => {
			assert.equal(hedberg("summary://1", "summary://1"), 1);
		});
	});
});
