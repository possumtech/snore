import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Budget from "./budget.js";

describe("Budget", () => {
	it("panicPrompt includes assembled, ceiling, target, and fidelity instructions", () => {
		const prompt = Budget.panicPrompt({
			assembledTokens: 4500,
			contextSize: 4000,
		});
		assert.ok(prompt.includes("4500"), "assembled in prompt");
		assert.ok(prompt.includes("4000"), "ceiling in prompt");
		assert.ok(prompt.includes("2000"), "50% target in prompt");
		assert.ok(prompt.includes("archive"), "archive instruction");
		assert.ok(prompt.includes("fidelity"), "fidelity instruction");
	});

	it("enforce returns 200 when under budget", async () => {
		const budget = new Budget({ hooks: { budget: null } });
		const result = await budget.enforce({
			contextSize: 10000,
			messages: [{ role: "system", content: "short" }],
			rows: [],
		});
		assert.strictEqual(result.status, 200);
		assert.ok(result.assembledTokens > 0);
	});

	it("enforce returns 413 when over budget", async () => {
		const budget = new Budget({ hooks: { budget: null } });
		const result = await budget.enforce({
			contextSize: 10,
			messages: [{ role: "system", content: "x".repeat(1000) }],
			rows: [],
		});
		assert.strictEqual(result.status, 413);
		assert.ok(result.overflow > 0);
	});

	it("enforce returns 200 with no contextSize", async () => {
		const budget = new Budget({ hooks: { budget: null } });
		const result = await budget.enforce({
			contextSize: null,
			messages: [{ role: "system", content: "anything" }],
			rows: [],
		});
		assert.strictEqual(result.status, 200);
		assert.strictEqual(result.assembledTokens, 0);
	});
});
