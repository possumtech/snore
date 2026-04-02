import assert from "node:assert/strict";
import { describe, it } from "node:test";
import slugify from "./slugify.js";

describe("slugify", () => {
	it("URI-encodes text", () => {
		assert.equal(slugify("Hello World"), "Hello%20World");
		assert.equal(slugify("npm --version"), "npm%20--version");
	});

	it("preserves URI-safe characters", () => {
		assert.equal(slugify("src/app.js"), "src%2Fapp.js");
		assert.equal(slugify("known://auth_flow"), "known%3A%2F%2Fauth_flow");
	});

	it("truncates to 80 characters", () => {
		const long = "a".repeat(100);
		assert.ok(slugify(long).length <= 80);
	});

	it("returns empty string for null/empty/undefined", () => {
		assert.equal(slugify(null), "");
		assert.equal(slugify(""), "");
		assert.equal(slugify(undefined), "");
	});

	it("handles special characters", () => {
		assert.equal(slugify("What's the capital?"), "What's%20the%20capital%3F");
	});
});
