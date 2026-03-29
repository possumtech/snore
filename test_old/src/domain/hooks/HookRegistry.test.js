import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import HookRegistry from "./HookRegistry.js";

describe("HookRegistry", () => {
	it("should run turn processors in priority order", async () => {
		const registry = new HookRegistry();
		const order = [];

		registry.onTurn(async () => {
			order.push(2);
		}, 20);

		registry.onTurn(async () => {
			order.push(1);
		}, 10);

		await registry.processTurn({});

		deepStrictEqual(order, [1, 2]);
	});

	it("should apply filters in priority order", async () => {
		const registry = new HookRegistry();

		registry.addFilter("test", (val) => `${val}B`, 20);
		registry.addFilter("test", (val) => `${val}A`, 10);

		const result = await registry.applyFilters("test", "Start");
		strictEqual(result, "StartAB");
	});

	it("should emit events in priority order", async () => {
		const registry = new HookRegistry();
		const order = [];

		registry.addEvent("test", () => order.push("A"), 10);
		registry.addEvent("test", () => order.push("B"), 20);

		await registry.emitEvent("test");
		deepStrictEqual(order, ["A", "B"]);
	});
});
