import assert from "node:assert";
import { describe, it } from "node:test";
import HookRegistry from "./HookRegistry.js";

describe("HookRegistry", () => {
	it("should execute actions in priority order", async () => {
		const registry = new HookRegistry();
		const results = [];

		registry.addAction("test_action", async () => results.push(2), 20);
		registry.addAction("test_action", async () => results.push(1), 10);

		await registry.doAction("test_action");
		assert.deepStrictEqual(results, [1, 2]);
	});

	it("should apply filters in priority order", async () => {
		const registry = new HookRegistry();

		registry.addFilter("test_filter", async (val) => `${val} world`, 20);
		registry.addFilter("test_filter", async (val) => `${val} hello`, 10);

		const result = await registry.applyFilters("test_filter", "start");
		assert.strictEqual(result, "start hello world");
	});

	it("should pass additional arguments to filters", async () => {
		const registry = new HookRegistry();

		registry.addFilter("test_args", async (val, extra) => val + extra, 10);

		const result = await registry.applyFilters("test_args", "base", " plus");
		assert.strictEqual(result, "base plus");
	});
});
