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

describe("Update.handler: dispatches via rummy.update with the entry's status", () => {
	function makeRummy() {
		const updateCalls = [];
		return {
			updateCalls,
			rummy: {
				update: async (body, opts) => updateCalls.push({ body, opts }),
			},
		};
	}

	it("status=200: forwards body and status to rummy.update", async () => {
		const plugin = new Update(NOOP_CORE);
		const { rummy, updateCalls } = makeRummy();
		await plugin.handler(
			{ scheme: "update", attributes: { status: 200 }, body: "Paris" },
			rummy,
		);
		assert.deepEqual(updateCalls, [{ body: "Paris", opts: { status: 200 } }]);
	});

	it("non-terminal status: forwards as-is (engine accepts any status)", async () => {
		const plugin = new Update(NOOP_CORE);
		const { rummy, updateCalls } = makeRummy();
		await plugin.handler(
			{ scheme: "update", attributes: { status: 102 }, body: "working" },
			rummy,
		);
		assert.deepEqual(updateCalls, [{ body: "working", opts: { status: 102 } }]);
	});

	it("missing status: forwards undefined (continuation update)", async () => {
		const plugin = new Update(NOOP_CORE);
		const { rummy, updateCalls } = makeRummy();
		await plugin.handler(
			{ scheme: "update", attributes: {}, body: "ongoing" },
			rummy,
		);
		assert.deepEqual(updateCalls, [
			{ body: "ongoing", opts: { status: undefined } },
		]);
	});
});
