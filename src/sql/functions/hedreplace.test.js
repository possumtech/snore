import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hedreplace, { deterministic } from "./hedreplace.js";

describe("hedreplace SQL function", () => {
	it("returns null when string is null", () => {
		assert.equal(hedreplace("a", "b", null), null);
	});

	it("delegates to hedreplace pattern engine", () => {
		const result = hedreplace("foo", "bar", "the foo is foo");
		assert.equal(typeof result, "string");
		assert.ok(result.includes("bar"), `got: ${result}`);
	});

	it("declares deterministic=true", () => {
		assert.equal(deterministic, true);
	});
});
