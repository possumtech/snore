import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
	describe("summary — 450-char preview (@budget_enforcement)", () => {
		it("empty body → empty preview", () => {
			assert.strictEqual(plugin.summary({ body: "" }), "");
			assert.strictEqual(plugin.summary({ body: null }), "");
		});

		it("body under 450 chars → returned whole, no marker", () => {
			const body = "What are the major rivers in Orange County, Indiana?";
			assert.strictEqual(plugin.summary({ body }), body);
		});

		it("body over 450 chars → first 450 + truncation marker, total ≤ 500", () => {
			const body = `${"q".repeat(450)}${"more".repeat(100)}`;
			const result = plugin.summary({ body });
			assert.ok(result.startsWith("q".repeat(450)));
			assert.ok(!result.includes("more"));
			assert.ok(result.includes("truncated"));
			assert.ok(
				result.length <= 500,
				`fits under materializeContext 500-char system cap; got ${result.length}`,
			);
		});
	});
});
