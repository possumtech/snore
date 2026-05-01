import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ceiling,
	computeBudget,
	measureMessages,
	measureRows,
} from "./budget.js";

describe("ceiling", () => {
	it("is contextSize × RUMMY_BUDGET_CEILING (floored)", () => {
		// .env.example sets BUDGET_CEILING; whatever it is, ceiling × inverse must round-trip approximately.
		const c = ceiling(10000);
		assert.ok(c > 0 && c <= 10000);
		assert.equal(c, ceiling(10000)); // deterministic
	});

	it("scales linearly with contextSize", () => {
		assert.equal(ceiling(2 * 10000), 2 * ceiling(10000));
	});

	it("returns 0 for zero context", () => {
		assert.equal(ceiling(0), 0);
	});
});

describe("measureMessages", () => {
	it("sums per-message content token counts", () => {
		const m = measureMessages([
			{ content: "" },
			{ content: "abcdefghij" }, // 10 chars
		]);
		assert.ok(m >= 1, `should yield > 0 tokens, got ${m}`);
	});

	it("returns 0 for empty messages array", () => {
		assert.equal(measureMessages([]), 0);
	});

	it("treats empty/missing content as 0 tokens", () => {
		assert.equal(measureMessages([{ content: "" }, { content: null }]), 0);
	});
});

describe("measureRows", () => {
	it("sums per-row body token counts", () => {
		const out = measureRows([{ body: "abcdef" }, { body: "ghi" }]);
		assert.ok(out >= 1);
	});

	it("returns 0 for empty rows", () => {
		assert.equal(measureRows([]), 0);
	});
});

describe("computeBudget", () => {
	it("returns ceiling, totalTokens, tokensFree, overflow, ok=true under ceiling", () => {
		const result = computeBudget({ contextSize: 10000, totalTokens: 100 });
		assert.equal(result.totalTokens, 100);
		assert.equal(result.tokenUsage, 100);
		assert.ok(result.ceiling > 100);
		assert.equal(result.tokensFree, result.ceiling - 100);
		assert.equal(result.overflow, 0);
		assert.equal(result.ok, true);
	});

	it("ok=false + overflow positive when totalTokens > ceiling", () => {
		const cap = ceiling(1000);
		const result = computeBudget({
			contextSize: 1000,
			totalTokens: cap + 50,
		});
		assert.equal(result.tokensFree, 0);
		assert.equal(result.overflow, 50);
		assert.equal(result.ok, false);
	});

	it("tokensFree clamps to 0 (never negative)", () => {
		const result = computeBudget({ contextSize: 100, totalTokens: 99999 });
		assert.equal(result.tokensFree, 0);
	});

	it("at-ceiling is ok=true (boundary)", () => {
		const cap = ceiling(1000);
		const result = computeBudget({ contextSize: 1000, totalTokens: cap });
		assert.equal(result.overflow, 0);
		assert.equal(result.tokensFree, 0);
		assert.equal(result.ok, true);
	});
});
