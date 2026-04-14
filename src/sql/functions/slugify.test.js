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
		assert.equal(slugify("known://auth_flow"), "known%3A/auth_flow");
	});

	it("drops empty segments from leading/trailing/double separators", () => {
		assert.equal(slugify(",foo,"), "foo");
		assert.equal(slugify("a,,b"), "a/b");
		assert.equal(slugify("//path"), "path");
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
