import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Budget from "./budget.js";

describe("Budget", () => {
	it("enforce returns ok when under budget", async () => {
		const budget = new Budget({
			hooks: { budget: null, tools: { onView: () => {} } },
			registerScheme: () => {},
		});
		const result = await budget.enforce({
			contextSize: 10000,
			messages: [{ role: "system", content: "short" }],
			rows: [],
		});
		assert.strictEqual(result.ok, true);
		assert.ok(result.assembledTokens > 0);
	});

	it("enforce returns overflow when over budget", async () => {
		const budget = new Budget({
			hooks: { budget: null, tools: { onView: () => {} } },
			registerScheme: () => {},
		});
		const result = await budget.enforce({
			contextSize: 10,
			messages: [{ role: "system", content: "x".repeat(1000) }],
			rows: [],
		});
		assert.strictEqual(result.ok, false);
		assert.ok(result.overflow > 0);
	});

	it("enforce returns ok with no contextSize", async () => {
		const budget = new Budget({
			hooks: { budget: null, tools: { onView: () => {} } },
			registerScheme: () => {},
		});
		const result = await budget.enforce({
			contextSize: null,
			messages: [{ role: "system", content: "anything" }],
			rows: [],
		});
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.assembledTokens, 0);
	});
});
