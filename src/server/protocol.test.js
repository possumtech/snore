import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RUMMY_PROTOCOL_VERSION } from "./protocol.js";

describe("server protocol version", () => {
	it("exports RUMMY_PROTOCOL_VERSION as a semver string", () => {
		assert.equal(typeof RUMMY_PROTOCOL_VERSION, "string");
		assert.match(RUMMY_PROTOCOL_VERSION, /^\d+\.\d+\.\d+$/);
	});

	it("MAJOR version is at least 1 (post-genesis)", () => {
		const major = Number(RUMMY_PROTOCOL_VERSION.split(".")[0]);
		assert.ok(major >= 1);
	});
});
