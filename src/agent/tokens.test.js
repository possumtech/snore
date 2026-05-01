import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countLines, countTokens } from "./tokens.js";

describe("countTokens", () => {
	it("returns 0 for empty/null/undefined", () => {
		assert.equal(countTokens(""), 0);
		assert.equal(countTokens(null), 0);
		assert.equal(countTokens(undefined), 0);
	});

	it("ceils chars / RUMMY_TOKEN_DIVISOR", () => {
		const divisor = Number(process.env.RUMMY_TOKEN_DIVISOR);
		assert.ok(Number.isFinite(divisor) && divisor > 0);
		// One char → 1 token (Math.ceil of any positive fraction).
		assert.equal(countTokens("a"), 1);
		// Boundary: divisor chars exactly → 1 token.
		assert.equal(countTokens("a".repeat(divisor)), 1);
		// divisor + 1 chars → 2 tokens (ceil).
		assert.equal(countTokens("a".repeat(divisor + 1)), 2);
	});

	it("scales with input length", () => {
		const divisor = Number(process.env.RUMMY_TOKEN_DIVISOR);
		const text = "a".repeat(divisor * 5);
		assert.equal(countTokens(text), 5);
	});
});

describe("countLines", () => {
	it("returns 0 for empty/null/undefined", () => {
		assert.equal(countLines(""), 0);
		assert.equal(countLines(null), 0);
		assert.equal(countLines(undefined), 0);
	});

	it("counts a single line with no trailing newline as 1", () => {
		assert.equal(countLines("hello"), 1);
	});

	it("counts a single line with trailing newline as 1", () => {
		assert.equal(countLines("hello\n"), 1);
	});

	it("counts multiple lines correctly", () => {
		assert.equal(countLines("a\nb\nc"), 3);
		assert.equal(countLines("a\nb\nc\n"), 3);
		assert.equal(countLines("a\n\nc"), 3);
	});

	it("treats trailing newline as a line terminator, not a new line", () => {
		// "a\n" is 1 line (trailing newline closes the only line).
		assert.equal(countLines("a\n"), 1);
		// "a\n\n" is 2 lines (one with content, one empty).
		assert.equal(countLines("a\n\n"), 2);
	});
});
