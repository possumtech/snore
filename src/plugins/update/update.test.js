import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Update from "./update.js";

const NOOP_CORE = {
	ensureTool() {},
	registerScheme() {},
	on() {},
	filter() {},
	hooks: {},
};

describe("Update", () => {
	const plugin = new Update(NOOP_CORE);

	it("full returns body", () => {
		assert.ok(plugin.full({ body: "working" }).includes("working"));
	});

	it("summary returns full", () => {
		assert.ok(plugin.summary({ body: "working" }).includes("working"));
	});
});

describe("Update.handler: validateNavigation rejection surfaces as <error> only", () => {
	// Per SPEC.md @fvsm_state_machine: a rejected advance does NOT
	// produce a phase-history entry. The only side effect on rejection
	// is an error.log emission (status 403). getCurrentPhase reads
	// only successful advances; recording a failed row would either
	// lie about advancement or require a special-case skip downstream.

	it("emits error.log with the rejection reason and status 403; writes no phase-history entry", async () => {
		const plugin = new Update(NOOP_CORE);
		const setCalls = [];
		const errorEmits = [];
		const rummy = {
			runId: 7,
			sequence: 3,
			loopId: 11,
			entries: {
				set: async (payload) => setCalls.push(payload),
			},
			hooks: {
				instructions: {
					validateNavigation: async () => ({
						ok: false,
						reason: "YOU MUST identify unknowns in current mode",
					}),
				},
				error: {
					log: { emit: async (payload) => errorEmits.push(payload) },
				},
			},
			update: async () => {
				throw new Error("update.update should not run on rejection");
			},
		};
		const entry = {
			scheme: "update",
			attributes: { status: 145 },
			body: "prompt decomposed",
			resultPath: "log://turn_3/update/stub",
		};
		await plugin.handler(entry, rummy);
		assert.equal(errorEmits.length, 1, "exactly one error.log emission");
		assert.equal(
			errorEmits[0].message,
			"YOU MUST identify unknowns in current mode",
		);
		assert.equal(errorEmits[0].status, 403);
		assert.equal(errorEmits[0].runId, 7);
		assert.equal(errorEmits[0].turn, 3);
		assert.equal(errorEmits[0].loopId, 11);
		assert.equal(setCalls.length, 0, "no phase-history entry written");
		assert.equal(entry.state, "failed");
		assert.equal(entry.outcome, "invalid_navigation");
	});

	it("invalid status (e.g. 999): emits error.log with status 422; writes no phase-history entry", async () => {
		const plugin = new Update(NOOP_CORE);
		const setCalls = [];
		const errorEmits = [];
		const rummy = {
			runId: 7,
			sequence: 3,
			loopId: 11,
			entries: {
				set: async (payload) => setCalls.push(payload),
			},
			hooks: {
				instructions: {
					validateNavigation: async () => ({ ok: true }),
				},
				error: {
					log: { emit: async (payload) => errorEmits.push(payload) },
				},
			},
		};
		const entry = {
			scheme: "update",
			attributes: { status: 999 },
			body: "garbage",
			resultPath: "log://turn_3/update/stub",
		};
		await plugin.handler(entry, rummy);
		assert.equal(errorEmits.length, 1);
		assert.equal(errorEmits[0].message, "Invalid status");
		assert.equal(errorEmits[0].status, 422);
		assert.equal(setCalls.length, 0, "no phase-history entry written");
		assert.equal(entry.state, "failed");
		assert.equal(entry.outcome, "invalid_status");
	});

	it("on success: validateNavigation passes → rummy.update runs, no error emitted", async () => {
		const plugin = new Update(NOOP_CORE);
		const errorEmits = [];
		let updateCalled = false;
		const rummy = {
			runId: 7,
			sequence: 3,
			loopId: 11,
			entries: { set: async () => {} },
			hooks: {
				instructions: {
					validateNavigation: async () => ({ ok: true }),
				},
				error: {
					log: { emit: async (payload) => errorEmits.push(payload) },
				},
			},
			update: async () => {
				updateCalled = true;
			},
		};
		await plugin.handler(
			{
				scheme: "update",
				attributes: { status: 145 },
				body: "prompt decomposed",
				resultPath: "log://turn_3/update/stub",
			},
			rummy,
		);
		assert.equal(updateCalled, true, "rummy.update was invoked");
		assert.equal(errorEmits.length, 0, "no error emitted on success");
	});
});
