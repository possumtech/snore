import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hedsearch, { deterministic } from "./hedsearch.js";

describe("hedsearch SQL function", () => {
	it("returns 0 when string is null", () => {
		assert.equal(hedsearch("foo", null), 0);
	});

	it("returns 1 on found, 0 on not-found", () => {
		assert.equal(hedsearch("foo", "the foo is here"), 1);
		assert.equal(hedsearch("zzz", "the foo is here"), 0);
	});

	it("declares deterministic=true", () => {
		assert.equal(deterministic, true);
	});
});
