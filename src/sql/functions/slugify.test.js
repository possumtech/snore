import assert from "node:assert/strict";
import { describe, it } from "node:test";
import slugify from "./slugify.js";

describe("slugify", () => {
	it("converts spaces to underscores", () => {
		assert.equal(slugify("Hello World"), "Hello_World");
		assert.equal(slugify("npm --version"), "npm_--version");
	});

	it("converts commas to path separators", () => {
		assert.equal(slugify("history,mongol,khan"), "history/mongol/khan");
		assert.equal(slugify("a,b,c"), "a/b/c");
	});

	it("combines comma and space substitution", () => {
		assert.equal(
			slugify("seven years war,europe,1756"),
			"seven_years_war/europe/1756",
		);
	});

	it("preserves explicit forward slashes as separators", () => {
		assert.equal(slugify("src/app.js"), "src/app.js");
		assert.equal(slugify("a/b/c"), "a/b/c");
	});

	it("encodes URL-unsafe characters within segments", () => {
		assert.equal(slugify("What's the capital?"), "What's_the_capital%3F");
	});

	it("replaces scheme separator '://' with '___' so it round-trips and never decodes to a misleading single-slash path", () => {
		assert.equal(slugify("known://auth_flow"), "known___auth_flow");
		assert.equal(
			slugify("unknown://geography/indiana/orange_county"),
			"unknown___geography/indiana/orange_county",
		);
		assert.equal(
			slugify("https://example.com/page"),
			"https___example.com/page",
		);
	});

	it("drops empty segments from leading/trailing/double separators", () => {
		assert.equal(slugify(",foo,"), "foo");
		assert.equal(slugify("a,,b"), "a/b");
		assert.equal(slugify("//path"), "path");
	});

	it("drops `.` and `..` path-navigation segments", () => {
		// CC-14: shell commands like `./executable --help` previously
		// slugged to `./executable_--help` because `.split("/").filter(Boolean)`
		// preserved the literal `.`. Picomatch then treats `.` as a
		// directory marker that `**` won't cross, so the model emitting
		// `<get path="sh://turn_N/**"/>` missed every `./X` entry.
		assert.equal(slugify("./executable --help"), "executable_--help");
		assert.equal(slugify("../parent/file"), "parent/file");
		assert.equal(slugify("./a/./b"), "a/b");
		// Plain leading dots (hidden files etc.) survive — only the
		// pure-`.` and pure-`..` segments are dropped.
		assert.equal(slugify(".env.example"), ".env.example");
	});

	it("truncates to 80 characters before transformation", () => {
		const long = "a".repeat(100);
		assert.ok(slugify(long).length <= 80);
	});

	it("returns empty string for null/empty/undefined", () => {
		assert.equal(slugify(null), "");
		assert.equal(slugify(""), "");
		assert.equal(slugify(undefined), "");
	});
});
