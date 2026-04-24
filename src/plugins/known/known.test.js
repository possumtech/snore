import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Known from "./known.js";

describe("Known", () => {
	const plugin = new Known({
		registerScheme() {},
		on() {},
		filter() {},
		markHidden() {},
	});

	it("full returns body only (no prefix — tag attributes carry the path)", () => {
		const result = plugin.full({ path: "known://auth", body: "JWT tokens" });
		assert.strictEqual(result, "JWT tokens");
	});

	// Summarized knowns keep the first 500 chars so the model doesn't
	// lose its own work when budget auto-demotion flips visibility on
	// prior-turn knowns. Large knowns get capped so summarized doesn't
	// saturate the packet either.
	describe("summary — 500-char preview (@budget_enforcement)", () => {
		it("empty body → empty preview", () => {
			assert.strictEqual(plugin.summary({ body: "" }), "");
			assert.strictEqual(plugin.summary({ body: null }), "");
		});

		it("body under 500 chars → returned whole, no truncation marker", () => {
			const body =
				"Lost River rises in Washington County, flows west into Orange County, sinks into karst.";
			const result = plugin.summary({ body });
			assert.strictEqual(result, body);
			assert.ok(!result.includes("truncated"));
		});

		it("body exactly 500 chars → returned whole, no marker", () => {
			const body = "x".repeat(500);
			const result = plugin.summary({ body });
			assert.strictEqual(result, body);
			assert.ok(!result.includes("truncated"));
		});

		it("body over 500 chars → first 500 + truncation marker", () => {
			const body = `${"x".repeat(500)}CUTOFF_SENTINEL${"x".repeat(400)}`;
			const result = plugin.summary({ body });
			assert.ok(
				result.startsWith("x".repeat(500)),
				"first 500 chars preserved",
			);
			assert.ok(
				!result.includes("CUTOFF_SENTINEL"),
				"chars beyond 500 excluded from preview",
			);
			assert.ok(
				result.includes("truncated"),
				"marker tells model there's more to promote",
			);
		});
	});
});
