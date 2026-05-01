import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../hooks/Hooks.js";
import materializeContext from "./materializeContext.js";

function makeDb({ viewRows = [], lastContext = null } = {}) {
	const inserted = [];
	let cleared = false;
	return {
		_inserted: inserted,
		_cleared: () => cleared,
		clear_turn_context: {
			run: async () => {
				cleared = true;
			},
		},
		get_model_context: { all: async () => viewRows },
		insert_turn_context: {
			run: async (params) => inserted.push(params),
		},
		get_turn_context: {
			all: async () =>
				inserted.map((i, ordinal) => ({ ...i, ordinal, scheme: "test" })),
		},
		get_last_context_tokens: { get: async () => lastContext },
	};
}

describe("materializeContext", () => {
	it("clears turn_context, repopulates from v_model_context, and assembles messages", async () => {
		const hooks = createHooks();
		// Project a known scheme so view() doesn't throw.
		hooks.tools.onView("file", (e) => e.body || "", "visible");
		hooks.tools.onView("file", (_e) => "", "summarized");

		const db = makeDb({
			viewRows: [
				{
					path: "src/x.js",
					scheme: null,
					body: "hello",
					attributes: null,
					category: "logging",
					visibility: "visible",
					state: "resolved",
					outcome: null,
					turn: 1,
					ordinal: 0,
				},
			],
			lastContext: { context_tokens: 100 },
		});
		const result = await materializeContext({
			db,
			hooks,
			runId: "r1",
			loopId: "l1",
			turn: 2,
			systemPrompt: "you are an agent",
			mode: "act",
			toolSet: new Set(),
			contextSize: 1000,
		});
		assert.ok(db._cleared());
		assert.equal(db._inserted.length, 1);
		assert.equal(db._inserted[0].path, "src/x.js");
		assert.ok(Array.isArray(result.rows));
		assert.ok(Array.isArray(result.messages));
		assert.equal(result.lastContextTokens, 100);
	});

	it("dispatches log entries to their action plugin's view via path segment", async () => {
		const hooks = createHooks();
		let viewedKey = null;
		hooks.tools.onView(
			"update",
			(entry) => {
				viewedKey = "update";
				return entry.body;
			},
			"visible",
		);
		hooks.tools.onView("update", () => "", "summarized");

		const db = makeDb({
			viewRows: [
				{
					path: "log://turn_1/update/x",
					scheme: "log",
					body: "summary text",
					attributes: null,
					category: "logging",
					visibility: "visible",
					state: "resolved",
					outcome: null,
					turn: 1,
					ordinal: 0,
				},
			],
		});
		await materializeContext({
			db,
			hooks,
			runId: "r1",
			loopId: "l1",
			turn: 2,
			systemPrompt: "x",
			mode: "act",
			toolSet: new Set(),
			contextSize: 1000,
		});
		assert.equal(viewedKey, "update");
	});

	it("defaults lastContextTokens=0 when no prior context recorded", async () => {
		const hooks = createHooks();
		hooks.tools.onView("file", () => "", "visible");
		hooks.tools.onView("file", () => "", "summarized");
		const db = makeDb({ viewRows: [], lastContext: null });
		const result = await materializeContext({
			db,
			hooks,
			runId: "r1",
			loopId: "l1",
			turn: 1,
			systemPrompt: "x",
			mode: "act",
			toolSet: new Set(),
			contextSize: 1000,
		});
		assert.equal(result.lastContextTokens, 0);
	});
});
