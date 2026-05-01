import assert from "node:assert/strict";
import { describe, it } from "node:test";
import config from "./config.js";

describe("agent config", () => {
	it("loads numeric required vars from env (.env.example)", () => {
		assert.equal(typeof config.BUDGET_CEILING, "number");
		assert.ok(config.BUDGET_CEILING > 0);
		assert.equal(typeof config.LLM_DEADLINE, "number");
		assert.equal(typeof config.MAX_STRIKES, "number");
		assert.equal(typeof config.MIN_CYCLES, "number");
		assert.equal(typeof config.MAX_CYCLE_PERIOD, "number");
		assert.equal(typeof config.FETCH_TIMEOUT, "number");
		assert.equal(typeof config.LOOP_TIMEOUT, "number");
		assert.equal(typeof config.PLUGINS_LOAD_TIMEOUT, "number");
		assert.equal(typeof config.LLM_MAX_BACKOFF, "number");
	});

	it("THINK is a boolean", () => {
		assert.equal(typeof config.THINK, "boolean");
	});

	it("config object is frozen (no mutation allowed)", () => {
		assert.equal(Object.isFrozen(config), true);
		assert.throws(() => {
			config.BUDGET_CEILING = 1;
		});
	});
});
