/**
 * instructions plugin: system prompt assembly + findLatestSummary helper.
 *
 * The plugin owns `instructions://system` rendering and exposes
 * `findLatestSummary` for callers (cli.js) that need the final
 * `<update status="200">` body to print as a run's answer.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import Instructions from "./instructions.js";

function makeHooks() {
	const hooks = createHooks();
	const core = new PluginContext("instructions", hooks);
	new Instructions(core);
	return hooks;
}

describe("findLatestSummary: returns the last status=200 update entry", () => {
	const hooks = makeHooks();

	function entry(turn, status) {
		return {
			path: `log://turn_${turn}/update/stub`,
			attributes: { status, action: "update" },
		};
	}

	it("picks the status=200 row from a mixed list", () => {
		const rows = [entry(1, 145), entry(2, 156), entry(3, 167), entry(4, 200)];
		const result = hooks.instructions.findLatestSummary(rows);
		assert.equal(result.path, "log://turn_4/update/stub");
	});

	it("returns the latest 200 when multiple terminal updates exist", () => {
		const rows = [entry(1, 200), entry(2, 200)];
		const result = hooks.instructions.findLatestSummary(rows);
		assert.equal(result.path, "log://turn_2/update/stub");
	});

	it("returns undefined when no 200 update is present", () => {
		const rows = [entry(1, 145), entry(2, 155)];
		const result = hooks.instructions.findLatestSummary(rows);
		assert.equal(result, undefined);
	});

	it("ignores entries that aren't update rows", () => {
		const rows = [
			{ path: "log://turn_1/get/foo", attributes: {} },
			entry(2, 200),
		];
		const result = hooks.instructions.findLatestSummary(rows);
		assert.equal(result.path, "log://turn_2/update/stub");
	});

	it("handles JSON-string attributes (raw DB shape)", () => {
		const rows = [
			{
				path: "log://turn_1/update/stub",
				attributes: JSON.stringify({ status: 200, action: "update" }),
			},
		];
		const result = hooks.instructions.findLatestSummary(rows);
		assert.equal(result.path, "log://turn_1/update/stub");
	});
});
