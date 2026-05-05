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

// The simplified protocol has one terminal status (200) and one coherence
// invariant: emit-200 requires no visible `unknown://` and no visible
// prior prompt. Continuation updates (no status, or any status ≠ 200)
// pass through without validation.
describe("Update.handler: 200 coherence gate (@fvsm_state_machine)", () => {
	function makeRummy({ visibleUnknowns = 0, visiblePriorPrompts = 0 } = {}) {
		const setCalls = [];
		const errorEmits = [];
		const updateCalls = [];
		const rummy = {
			runId: 7,
			sequence: 3,
			loopId: 11,
			entries: {
				set: async (payload) => setCalls.push(payload),
				getEntriesByPattern: async (_runId, pattern) => {
					if (pattern === "unknown://**") {
						return Array.from({ length: visibleUnknowns }, (_, i) => ({
							path: `unknown://x${i}`,
							visibility: "visible",
						}));
					}
					if (pattern === "prompt://*") {
						// Always at least one "current" prompt; older ones are
						// the prior-prompt set the gate filters for.
						const all = Array.from(
							{ length: visiblePriorPrompts + 1 },
							(_, i) => ({
								path: `prompt://${i + 1}`,
								visibility: "visible",
							}),
						);
						return all;
					}
					return [];
				},
			},
			hooks: {
				error: {
					log: { emit: async (payload) => errorEmits.push(payload) },
				},
			},
			update: async (body, opts) => {
				updateCalls.push({ body, opts });
			},
		};
		return { rummy, setCalls, errorEmits, updateCalls };
	}

	it("status=200 with no visible unknowns and no prior prompts → rummy.update fires, no error", async () => {
		const plugin = new Update(NOOP_CORE);
		const { rummy, errorEmits, updateCalls } = makeRummy();
		await plugin.handler(
			{
				scheme: "update",
				attributes: { status: 200 },
				body: "Paris",
				resultPath: "log://turn_3/update/stub",
			},
			rummy,
		);
		assert.equal(updateCalls.length, 1, "rummy.update fired");
		assert.equal(errorEmits.length, 0, "no error emitted on coherent delivery");
	});

	it("status=200 with visible unknowns → fail; error.log fires with 403; no rummy.update", async () => {
		const plugin = new Update(NOOP_CORE);
		const { rummy, errorEmits, updateCalls } = makeRummy({
			visibleUnknowns: 2,
		});
		const entry = {
			scheme: "update",
			attributes: { status: 200 },
			body: "Paris",
			resultPath: "log://turn_3/update/stub",
		};
		await plugin.handler(entry, rummy);
		assert.equal(updateCalls.length, 0, "rummy.update did not run");
		assert.equal(entry.state, "failed");
		assert.equal(entry.outcome, "incoherent_delivery");
		assert.match(entry.body, /2 unknown\(s\) still visible/);
		assert.equal(errorEmits.length, 1);
		assert.equal(errorEmits[0].status, 403);
		assert.match(errorEmits[0].message, /2 unknown\(s\) still visible/);
	});

	it("status=200 with visible prior prompts → fail; error.log fires with 403", async () => {
		const plugin = new Update(NOOP_CORE);
		const { rummy, errorEmits, updateCalls } = makeRummy({
			visiblePriorPrompts: 1,
		});
		const entry = {
			scheme: "update",
			attributes: { status: 200 },
			body: "answer",
			resultPath: "log://turn_3/update/stub",
		};
		await plugin.handler(entry, rummy);
		assert.equal(updateCalls.length, 0);
		assert.equal(entry.state, "failed");
		assert.match(entry.body, /1 prior prompt\(s\) still visible/);
		assert.equal(errorEmits[0].status, 403);
	});

	it("continuation update (no status) passes through without coherence check", async () => {
		const plugin = new Update(NOOP_CORE);
		const { rummy, errorEmits, updateCalls } = makeRummy({
			visibleUnknowns: 5, // would block 200 — but no status means no check
		});
		await plugin.handler(
			{
				scheme: "update",
				attributes: {},
				body: "still working on the watershed names",
				resultPath: "log://turn_3/update/stub",
			},
			rummy,
		);
		assert.equal(updateCalls.length, 1);
		assert.equal(errorEmits.length, 0);
	});

	it("any non-200 status passes through without validation", async () => {
		const plugin = new Update(NOOP_CORE);
		const { rummy, errorEmits, updateCalls } = makeRummy({
			visibleUnknowns: 3,
		});
		await plugin.handler(
			{
				scheme: "update",
				attributes: { status: 155 },
				body: "habit-of-old status; engine accepts",
				resultPath: "log://turn_3/update/stub",
			},
			rummy,
		);
		assert.equal(updateCalls.length, 1);
		assert.equal(errorEmits.length, 0);
	});
});
