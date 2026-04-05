import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hedmatch, hedreplace, hedsearch } from "./hedberg.js";

describe("hedberg", () => {
	describe("glob patterns", () => {
		it("matches wildcard", () => {
			assert.equal(hedmatch("*.js", "index.js"), true);
			assert.equal(hedmatch("*.js", "readme.md"), false);
		});

		it("matches single char wildcard", () => {
			assert.equal(hedmatch("????.ts", "test.ts"), true);
			assert.equal(hedmatch("????.ts", "index.ts"), false);
		});

		it("matches globstar", () => {
			assert.equal(hedmatch("src/**/*.ts", "src/a/b.ts"), true);
			assert.equal(hedmatch("src/**/*.ts", "lib/a.ts"), false);
		});

		it("matches character class", () => {
			assert.equal(hedmatch("[abc]*.js", "alpha.js"), true);
			assert.equal(hedmatch("[abc]*.js", "delta.js"), false);
		});

		it("handles null string", () => {
			assert.equal(hedmatch("*.js", null), false);
		});
	});

	describe("glob NOT misdetected as regex", () => {
		it("file+name.txt stays glob", () => {
			assert.equal(hedmatch("file+name.txt", "file+name.txt"), true);
			assert.equal(hedmatch("file+name.txt", "fileXname.txt"), false);
		});

		it("c++ stays glob", () => {
			assert.equal(hedmatch("c++", "c++"), true);
		});

		it("parens in path stay glob", () => {
			assert.equal(
				hedmatch("src/utils (copy)/*", "src/utils (copy)/file.js"),
				true,
			);
		});

		it("non-numeric brace expansion stays glob", () => {
			assert.equal(hedmatch("log{a,b}.txt", "log{a,b}.txt"), true);
		});

		it("globstar with dotted extensions stays glob", () => {
			assert.equal(hedmatch("**/*.test.*", "src/foo.test.js"), true);
			assert.equal(hedmatch("**/*.test.*", "src/foo.js"), false);
		});

		it("*.foo.* stays glob not regex", () => {
			assert.equal(hedmatch("*.foo.*", "bar.foo.baz"), true);
			assert.equal(hedmatch("*.foo.*", "nope"), false);
		});
	});

	describe("regex patterns (require /slashes/)", () => {
		it("slash-delimited regex matches", () => {
			assert.equal(hedmatch("/^(index|utils)/", "index.js"), true);
			assert.equal(hedmatch("/^(index|utils)/", "readme.md"), false);
		});

		it("regex with escape sequences", () => {
			assert.equal(hedmatch("/\\.(js|ts)$/", "test.ts"), true);
			assert.equal(hedmatch("/\\.(js|ts)$/", "test.py"), false);
		});

		it("regex with quantifiers", () => {
			assert.equal(hedmatch("/foo.+bar/", "foo123bar"), true);
			assert.equal(hedmatch("/\\d+/", "abc123"), true);
			assert.equal(hedmatch("/\\d+/", "abcdef"), false);
		});

		it("unslashed patterns are literal, not regex", () => {
			// Without slashes, these are literal text — no regex detection
			assert.equal(hedmatch("\\d+", "\\d+"), true);
			assert.equal(hedmatch("\\d+", "abc123"), false);
		});
	});

	describe("regex NOT misdetected as jsonpath", () => {
		it("$.+ with slashes is regex not jsonpath", () => {
			assert.equal(hedmatch("/$.+/", "anything"), false);
		});
	});

	describe("xpath patterns", () => {
		const xml =
			'<root><item id="3"><name>test</name></item><item id="5"/></root>';

		it("matches //element", () => {
			assert.equal(hedmatch("//item", xml), true);
			assert.equal(hedmatch("//missing", xml), false);
		});

		it("matches //element with attribute predicate", () => {
			assert.equal(hedmatch("//item[@id='3']", xml), true);
			assert.equal(hedmatch("//item[@id='99']", xml), false);
		});

		it("matches absolute path with positional predicate", () => {
			assert.equal(hedmatch("/root/item[1]", xml), true);
		});

		it("matches xpath with function in predicate", () => {
			assert.equal(hedmatch("/root/item[position()>1]", xml), true);
		});

		it("matches xpath with axis", () => {
			assert.equal(hedmatch("//item/child::name", xml), true);
		});

		it("returns 0 for non-XML string", () => {
			assert.equal(hedmatch("//div", "just plain text"), false);
		});
	});

	describe("xpath NOT misdetected", () => {
		it("C++ namespace path stays glob", () => {
			assert.equal(
				hedmatch("/path/to/std::vector.html", "/path/to/std::vector.html"),
				true,
			);
		});
	});

	describe("jsonpath patterns", () => {
		const json = JSON.stringify({
			name: "alice",
			items: [{ id: 1 }, { id: 2 }],
			nested: { deep: { value: 42 } },
		});

		it("matches property access", () => {
			assert.equal(hedmatch("$.name", json), true);
		});

		it("matches nested property", () => {
			assert.equal(hedmatch("$.nested.deep.value", json), true);
		});

		it("matches array index", () => {
			assert.equal(hedmatch("$.items[0].id", json), true);
		});

		it("matches array wildcard", () => {
			assert.equal(hedmatch("$.items[*].id", json), true);
		});

		it("matches recursive descent", () => {
			assert.equal(hedmatch("$..value", json), true);
			assert.equal(hedmatch("$..missing", json), false);
		});

		it("returns 0 for missing key", () => {
			assert.equal(hedmatch("$.missing", json), false);
		});

		it("returns 0 for non-JSON string", () => {
			assert.equal(hedmatch("$.name", "not json"), false);
		});
	});

	describe("scheme paths stay glob", () => {
		it("edit:// is glob", () => {
			assert.equal(hedmatch("edit://*", "edit://3"), true);
		});

		it("summary:// is glob", () => {
			assert.equal(hedmatch("summary://1", "summary://1"), true);
		});
	});

	describe("literal detection (default)", () => {
		it("plain text without pattern chars is literal", () => {
			assert.equal(hedmatch(":AI[]", ":AI[]"), true);
			assert.equal(hedmatch(":AI[]", ":AI[x]"), false);
		});

		it("backslashes without /slashes/ are literal", () => {
			assert.equal(hedmatch("\\d+", "\\d+"), true);
			assert.equal(hedmatch("\\d+", "123"), false);
		});
	});

	describe("hedsearch — substring", () => {
		it("finds literal substring", () => {
			const r = hedsearch("port = 3000", "const port = 3000;\n");
			assert.equal(r.found, true);
			assert.equal(r.match, "port = 3000");
			assert.equal(r.index, 6);
		});

		it("finds :AI[] literally", () => {
			const r = hedsearch(":AI[]", "function() {\n:AI[]\n}");
			assert.equal(r.found, true);
			assert.equal(r.match, ":AI[]");
		});

		it("regex search with /slashes/", () => {
			const r = hedsearch("/\\d+/", "port = 3000");
			assert.equal(r.found, true);
			assert.equal(r.match, "3000");
		});

		it("glob search finds pattern in content", () => {
			const r = hedsearch("*.js", "import from app.js");
			assert.equal(r.found, true);
		});

		it("returns not found", () => {
			const r = hedsearch("missing", "nothing here");
			assert.equal(r.found, false);
		});
	});

	describe("hedreplace", () => {
		it("replaces literal", () => {
			const r = hedreplace("3000", "8080", "port = 3000");
			assert.equal(r, "port = 8080");
		});

		it("replaces with /regex/", () => {
			const r = hedreplace("/\\d+/", "NUM", "port = 3000");
			assert.equal(r, "port = NUM");
		});

		it("returns null when not found", () => {
			assert.equal(hedreplace("missing", "x", "nothing"), null);
		});
	});

	describe("sed syntax — s/search/replace/flags", () => {
		it("literal sed replace", () => {
			const r = hedreplace("s/3000/8080/", null, "port = 3000");
			assert.equal(r, "port = 8080");
		});

		it("sed with global flag uses regex", () => {
			const r = hedreplace("s/\\d+/NUM/g", null, "port = 3000, timeout = 5000");
			assert.equal(r, "port = NUM, timeout = NUM");
		});

		it("sed with case insensitive flag", () => {
			const r = hedreplace("s/hello/world/gi", null, "Hello hello HELLO");
			assert.equal(r, "world world world");
		});

		it("sed search detects in content", () => {
			const r = hedsearch("s/3000/8080/", "port = 3000");
			assert.equal(r.found, true);
			assert.equal(r.match, "3000");
		});

		it("sed match checks for search text in string", () => {
			assert.equal(hedmatch("s/3000/8080/", "3000"), true);
			assert.equal(hedmatch("s/3000/8080/", "port = 3000"), true);
			assert.equal(hedmatch("s/3000/8080/", "no match"), false);
		});
	});
});
