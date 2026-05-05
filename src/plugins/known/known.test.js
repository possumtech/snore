import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SUMMARY_MAX_CHARS } from "../helpers.js";
import Known from "./known.js";

describe("Known", () => {
	const plugin = new Known({
		registerScheme() {},
		ensureTool() {},
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
	describe("summary — body-cap preview (@budget_enforcement)", () => {
		it("empty body → empty preview", () => {
			assert.strictEqual(plugin.summary({ body: "" }), "");
			assert.strictEqual(plugin.summary({ body: null }), "");
		});

		it("short body → returned whole", () => {
			const body =
				"Lost River rises in Washington County, flows west into Orange County, sinks into karst.";
			assert.strictEqual(plugin.summary({ body }), body);
		});

		it("any body produces output within the contract floor", () => {
			const giant = "x".repeat(50000);
			const result = plugin.summary({ body: giant });
			assert.ok(
				result.length <= SUMMARY_MAX_CHARS,
				`summary ≤ SUMMARY_MAX_CHARS; got ${result.length}`,
			);
		});
	});
});
