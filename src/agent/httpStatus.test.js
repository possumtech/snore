import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stateToStatus } from "./httpStatus.js";

describe("stateToStatus", () => {
	it("outcome's 3-digit prefix wins over state", () => {
		assert.equal(stateToStatus("resolved", "status:422"), 422);
		assert.equal(stateToStatus("failed", "status:200"), 200);
		assert.equal(stateToStatus("resolved", "503: backend overloaded"), 503);
	});

	it("falls through to state when outcome has no 3-digit run", () => {
		assert.equal(stateToStatus("resolved", "permission"), 200);
		assert.equal(stateToStatus("failed", "not_found"), 500);
	});

	it("ignores non-3-digit numbers in outcome", () => {
		// Two-digit and four-digit numbers still match by the first three
		// digits encountered: regex /(\d{3})/ matches the first 3 in a row.
		assert.equal(stateToStatus("resolved", "12 chars"), 200); // no run of 3
		assert.equal(stateToStatus("failed", "1234"), 123); // matches "123"
	});

	it("treats outcome=null as no override", () => {
		assert.equal(stateToStatus("resolved", null), 200);
		assert.equal(stateToStatus("resolved"), 200); // default
	});

	it("maps each documented state without outcome", () => {
		assert.equal(stateToStatus("resolved"), 200);
		assert.equal(stateToStatus("proposed"), 202);
		assert.equal(stateToStatus("streaming"), 102);
		assert.equal(stateToStatus("cancelled"), 499);
		assert.equal(stateToStatus("failed"), 500);
	});

	it("throws on unknown state", () => {
		assert.throws(
			() => stateToStatus("undefined-state"),
			/stateToStatus: unknown state/,
		);
	});
});
