import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hedmatch, { deterministic as hedmatchDet } from "./hedmatch.js";

describe("hedmatch SQL function", () => {
	it("returns 0 when string is null", () => {
		assert.equal(hedmatch("foo", null), 0);
	});

	it("returns 1 on match, 0 on no-match", () => {
		assert.equal(hedmatch("src/app.js", "src/app.js"), 1);
		assert.equal(hedmatch("src/*.js", "src/app.js"), 1);
		assert.equal(hedmatch("src/*.js", "test/app.js"), 0);
	});

	it("declares deterministic=true (sqlite optimization)", () => {
		assert.equal(hedmatchDet, true);
	});
});
