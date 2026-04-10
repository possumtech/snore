import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Known from "./known.js";

describe("Known", () => {
	const plugin = new Known({
		registerScheme() {},
		on() {},
		filter() {},
	});

	it("full renders path and body", () => {
		const result = plugin.full({ path: "known://auth", body: "JWT tokens" });
		assert.ok(result.includes("known://auth"));
		assert.ok(result.includes("JWT tokens"));
	});
});
