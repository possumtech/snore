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

describe("Update.handler: validateNavigation rejection surfaces as <error>", () => {
	// When validateNavigation rejects (shields 1/2 etc.), update.js must
	// (a) record a failed entry on the result path so getCurrentPhase
	// can recognize it as failed, AND (b) emit error.log so the rejection
	// renders as an <error> block in the next turn's user packet —
	// alone, the failed-update line is too low-prominence for the model
	// to course-correct on. This mirrors policy.js shield 3.
	function makeRummy(reason) {
		const setCalls = [];
		const errorEmits = [];
		return {
			rummy: {
				runId: 7,
				sequence: 3,
				loopId: 11,
				entries: {
					set: async (payload) => {
						setCalls.push(payload);
					},
				},
				hooks: {
					instructions: {
						validateNavigation: async () => ({ ok: false, reason }),
					},
					error: {
						log: {
							emit: async (payload) => {
								errorEmits.push(payload);
							},
						},
					},
				},
				update: async () => {
					throw new Error("update.update should not run on rejection");
				},
			},
			setCalls,
			errorEmits,
		};
	}

	it("emits error.log with the rejection reason and status 403", async () => {
		const plugin = new Update(NOOP_CORE);
		const { rummy, errorEmits } = makeRummy(
			"YOU MUST identify unknowns in current mode",
		);
		const entry = {
			scheme: "update",
			attributes: { status: 145 },
			body: "prompt decomposed",
			resultPath: "log://turn_3/update/stub",
		};
		// Provide store/turn/runId/loopId via the rummy's surface (handler uses them).
		rummy.entries = {
			set: async () => {},
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
	});

	it("records the failed entry with state='failed' and outcome='invalid_navigation'", async () => {
		const plugin = new Update(NOOP_CORE);
		const setCalls = [];
		const errorEmits = [];
		const rummy = {
			runId: 7,
			sequence: 3,
			loopId: 11,
			entries: {
				set: async (payload) => {
					setCalls.push(payload);
				},
			},
			hooks: {
				instructions: {
					validateNavigation: async () => ({
						ok: false,
						reason: "YOU MUST identify knowns in current mode",
					}),
				},
				error: {
					log: {
						emit: async (payload) => errorEmits.push(payload),
					},
				},
			},
		};
		const entry = {
			scheme: "update",
			attributes: { status: 156 },
			body: "all known",
			resultPath: "log://turn_3/update/stub",
		};
		await plugin.handler(entry, rummy);
		assert.equal(setCalls.length, 1, "exactly one entry recorded");
		assert.equal(setCalls[0].state, "failed");
		assert.equal(setCalls[0].outcome, "invalid_navigation");
		assert.equal(setCalls[0].attributes.status, 156);
		assert.equal(entry.state, "failed");
		assert.equal(entry.outcome, "invalid_navigation");
	});

	it("on success: validateNavigation passes → update.update runs, no error emitted", async () => {
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
