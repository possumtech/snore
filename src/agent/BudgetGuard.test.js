import assert from "node:assert/strict";
import { describe, it } from "node:test";
import BudgetGuard, { BudgetExceeded } from "./BudgetGuard.js";

describe("BudgetGuard", () => {
	it("no ceiling allows any amount", () => {
		const guard = new BudgetGuard(null, 0);
		guard.check(999999, "big://entry");
		assert.strictEqual(guard.remaining, Infinity);
	});

	it("under budget passes", () => {
		const guard = new BudgetGuard(1000, 500);
		guard.check(400, "known://fits");
		assert.strictEqual(guard.remaining, 500);
	});

	it("over budget throws BudgetExceeded", () => {
		const guard = new BudgetGuard(1000, 800);
		assert.throws(
			() => guard.check(300, "known://too-big"),
			(err) => {
				assert.ok(err instanceof BudgetExceeded);
				assert.strictEqual(err.status, 413);
				assert.strictEqual(err.path, "known://too-big");
				assert.strictEqual(err.requested, 300);
				assert.strictEqual(err.remaining, 200);
				return true;
			},
		);
	});

	it("exactly at budget passes", () => {
		const guard = new BudgetGuard(1000, 800);
		guard.check(200, "known://exact");
	});

	it("charge accumulates and reduces remaining", () => {
		const guard = new BudgetGuard(1000, 0);
		assert.strictEqual(guard.remaining, 1000);
		guard.charge(300);
		assert.strictEqual(guard.remaining, 700);
		assert.strictEqual(guard.spent, 300);
		guard.charge(200);
		assert.strictEqual(guard.remaining, 500);
		assert.strictEqual(guard.spent, 500);
	});

	it("tripped blocks all subsequent checks", () => {
		const guard = new BudgetGuard(1000, 0);
		guard.trip("set://overflow");
		assert.ok(guard.isTripped);
		assert.strictEqual(guard.tripSource, "set://overflow");
		assert.throws(
			() => guard.check(1, "known://tiny"),
			(err) => {
				assert.ok(err instanceof BudgetExceeded);
				assert.strictEqual(err.remaining, 0);
				return true;
			},
		);
	});

	it("negative delta always passes", () => {
		const guard = new BudgetGuard(100, 100);
		assert.strictEqual(guard.remaining, 0);
		guard.check(-50, "known://shrink");
		guard.check(0, "known://noop");
	});

	it("negative charge does not increase spent", () => {
		const guard = new BudgetGuard(1000, 0);
		guard.charge(-100);
		assert.strictEqual(guard.spent, 0);
		assert.strictEqual(guard.remaining, 1000);
	});

	it("delta computes correctly for new entry", () => {
		const delta = BudgetGuard.delta("hello world", null);
		assert.ok(delta > 0);
	});

	it("delta computes correctly for update", () => {
		const delta = BudgetGuard.delta("hello world updated", "hello world");
		assert.ok(delta > 0);
	});

	it("delta is negative when entry shrinks", () => {
		const delta = BudgetGuard.delta("hi", "hello world long content here");
		assert.ok(delta < 0);
	});
});
