import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SUMMARY_MAX_CHARS } from "../helpers.js";
import Unknown from "./unknown.js";

describe("Unknown", () => {
	const plugin = new Unknown({
		registerScheme() {},
		ensureTool() {},
		on() {},
		filter() {},
		markHidden() {},
	});

	it("full returns body", () => {
		const result = plugin.full({ body: "What are the rivers?" });
		assert.strictEqual(result, "What are the rivers?");
	});

	// Summarized unknowns keep the first 500 chars for the same reason
	// knowns do: auto-demotion shouldn't erase the question the model
	// is trying to answer. See known.test.js for the parallel contract.
	describe("summary — body-cap preview (@budget_enforcement)", () => {
		it("empty body → empty preview", () => {
			assert.strictEqual(plugin.summary({ body: "" }), "");
			assert.strictEqual(plugin.summary({ body: null }), "");
		});

		it("short body → returned whole", () => {
			const body = "What are the major rivers in Orange County, Indiana?";
			assert.strictEqual(plugin.summary({ body }), body);
		});

		it("any body produces output within the contract floor", () => {
			const giant = "q".repeat(50000);
			const result = plugin.summary({ body: giant });
			assert.ok(
				result.length <= SUMMARY_MAX_CHARS,
				`summary ≤ SUMMARY_MAX_CHARS; got ${result.length}`,
			);
		});
	});
});
