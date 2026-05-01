import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import Yolo from "./yolo.js";

function makeCore() {
	const hooks = createHooks();
	const core = new PluginContext("yolo", hooks);
	new Yolo(core);
	return { hooks, core };
}

function makeStore({ attrs = null, state = null } = {}) {
	const calls = [];
	return {
		_calls: calls,
		set: async (params) => calls.push(params),
		getAttributes: async () => attrs,
		getState: async () => state,
		getEntriesByPattern: async () => [],
	};
}

describe("Yolo plugin", () => {
	it("subscribes to proposal.pending", async () => {
		const { hooks } = makeCore();
		// No yolo flag → no-op even when proposed array provided.
		await hooks.proposal.pending.emit({
			rummy: { yolo: false },
			proposed: [{ path: "log://turn_1/sh/x" }],
		});
	});

	it("does nothing when rummy.yolo falsy", async () => {
		const { hooks } = makeCore();
		const store = makeStore();
		await hooks.proposal.pending.emit({
			rummy: { yolo: false, runId: "r", entries: store, db: {} },
			proposed: [{ path: "log://turn_1/sh/x" }],
		});
		assert.deepEqual(store._calls, []);
	});

	it("on yolo=true: vetoed proposals are recorded as failed", async () => {
		const { hooks } = makeCore();
		const store = makeStore();
		hooks.proposal.accepting.addFilter(async () => ({
			allow: false,
			outcome: "permission",
			body: "denied",
		}));
		await hooks.proposal.pending.emit({
			rummy: {
				yolo: true,
				runId: "r1",
				entries: store,
				db: {
					get_run_by_id: { get: async () => ({ project_id: "p1" }) },
					get_project_by_id: {
						get: async () => ({ project_root: null }),
					},
				},
			},
			proposed: [{ path: "log://turn_1/set/x" }],
		});
		const fail = store._calls.find((c) => c.state === "failed");
		assert.ok(fail);
		assert.equal(fail.outcome, "permission");
		assert.equal(fail.body, "denied");
	});

	it("on yolo=true: accepted proposals get resolved + emit proposal.accepted", async () => {
		const { hooks } = makeCore();
		const store = makeStore({ state: { turn: 7 } });
		let acceptedEvt;
		hooks.proposal.accepted.on((ctx) => {
			acceptedEvt = ctx;
		});
		hooks.proposal.content.addFilter(async () => "resolved-body");
		await hooks.proposal.pending.emit({
			rummy: {
				yolo: true,
				runId: "r1",
				entries: store,
				db: {
					get_run_by_id: { get: async () => ({ project_id: "p1" }) },
					get_project_by_id: {
						get: async () => ({ project_root: null }),
					},
				},
			},
			proposed: [{ path: "log://turn_1/set/x" }],
		});
		const resolved = store._calls.find((c) => c.state === "resolved");
		assert.ok(resolved);
		assert.equal(resolved.body, "resolved-body");
		assert.equal(resolved.turn, 7);
		assert.equal(acceptedEvt.resolvedBody, "resolved-body");
	});
});
