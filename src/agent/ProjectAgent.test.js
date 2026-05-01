import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../hooks/Hooks.js";
import ProjectAgent from "./ProjectAgent.js";

function makeDb() {
	return {
		_calls: [],
		get_all_schemes: { all: async () => [] },
		upsert_project: {
			get: async (params) => ({ id: 99, ...params }),
		},
	};
}

describe("ProjectAgent", () => {
	it("constructor initializes entries + agent loop without crashing", () => {
		const agent = new ProjectAgent(makeDb(), createHooks());
		assert.ok(agent);
		assert.ok(agent.entries);
	});

	it("init upserts project + emits project.init.started/completed", async () => {
		const hooks = createHooks();
		const events = [];
		hooks.project.init.started.on((e) =>
			events.push({ phase: "started", ...e }),
		);
		hooks.project.init.completed.on((e) =>
			events.push({ phase: "completed", projectId: e.projectId }),
		);
		const db = makeDb();
		const agent = new ProjectAgent(db, hooks);
		const result = await agent.init("proj", "/root", "/cfg");
		assert.deepEqual(result, { projectId: 99 });
		assert.equal(events.length, 2);
		assert.equal(events[0].phase, "started");
		assert.equal(events[0].projectName, "proj");
		assert.equal(events[0].projectRoot, "/root");
		assert.equal(events[1].phase, "completed");
		assert.equal(events[1].projectId, 99);
	});

	it("ask/act/resolve/inject/ensureRun/getRunHistory/abortRun/shutdown are exposed", () => {
		const agent = new ProjectAgent(makeDb(), createHooks());
		for (const m of [
			"ask",
			"act",
			"resolve",
			"inject",
			"ensureRun",
			"getRunHistory",
			"abortRun",
			"shutdown",
		]) {
			assert.equal(typeof agent[m], "function", `${m} should be exposed`);
		}
	});

	it("entries getter returns the same instance every time", () => {
		const agent = new ProjectAgent(makeDb(), createHooks());
		assert.strictEqual(agent.entries, agent.entries);
	});

	it("shutdown drains active runs without crashing when none active", async () => {
		const agent = new ProjectAgent(makeDb(), createHooks());
		await agent.shutdown();
	});

	it("abortRun on unknown id is a no-op", () => {
		const agent = new ProjectAgent(makeDb(), createHooks());
		agent.abortRun("never-existed");
	});
});
