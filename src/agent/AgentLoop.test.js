import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../hooks/Hooks.js";
import AgentLoop from "./AgentLoop.js";

describe("AgentLoop", () => {
	it("constructs with the documented dependencies", () => {
		const loop = new AgentLoop({}, {}, createHooks(), {}, {});
		assert.ok(loop);
		assert.equal(typeof loop.run, "function");
		assert.equal(typeof loop.resolve, "function");
		assert.equal(typeof loop.abort, "function");
		assert.equal(typeof loop.abortAll, "function");
		assert.equal(typeof loop.inject, "function");
		assert.equal(typeof loop.ensureRun, "function");
		assert.equal(typeof loop.getRunHistory, "function");
	});

	it("abort(unknownId) is a no-op (no throw)", () => {
		const loop = new AgentLoop({}, {}, createHooks(), {}, {});
		loop.abort("never-was-active");
	});

	it("abortAll() resolves immediately with no in-flight runs", async () => {
		const loop = new AgentLoop({}, {}, createHooks(), {}, {});
		await loop.abortAll();
	});
});
