import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../hooks/Hooks.js";
import TurnExecutor from "./TurnExecutor.js";

describe("TurnExecutor", () => {
	it("constructs with documented dependencies", () => {
		const exec = new TurnExecutor({}, {}, createHooks(), {});
		assert.ok(exec);
		assert.equal(typeof exec.execute, "function");
	});
});
