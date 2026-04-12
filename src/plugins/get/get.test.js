import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Get from "./get.js";

function makeStore(entries = []) {
	const upserted = [];
	return {
		upserted,
		getEntriesByPattern: async () => entries,
		promoteByPattern: async () => {},
		setFidelity: async () => {},
		upsert: async (runId, turn, path, body, status, opts) => {
			upserted.push({ path, body, status });
		},
	};
}

function makeRummy(store, attrs = {}) {
	return {
		entries: store,
		sequence: 1,
		runId: 1,
		loopId: 1,
	};
}

function makeEntry(attrs) {
	return {
		attributes: { path: "src/agent/AgentLoop.js", ...attrs },
		resultPath: "get://result",
	};
}

const plugin = new Get({
	registerScheme: () => {},
	on: () => {},
	filter: () => {},
});

describe("Get partial read (line/limit)", () => {
	it("returns a line slice without promoting", async () => {
		const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
		const store = makeStore([{ path: "src/agent/AgentLoop.js", body, tokens_full: 500 }]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ line: "10", limit: "5" });

		await plugin.handler(entry, rummy);

		assert.strictEqual(store.upserted.length, 1);
		const result = store.upserted[0];
		assert.strictEqual(result.status, 200);
		assert.ok(result.body.startsWith("[lines 10–14 / 100 total]"), `unexpected header: ${result.body.slice(0, 40)}`);
		assert.ok(result.body.includes("line 10"));
		assert.ok(result.body.includes("line 14"));
		assert.ok(!result.body.includes("line 15"));
	});

	it("limit only defaults start to line 1", async () => {
		const body = "a\nb\nc\nd\ne";
		const store = makeStore([{ path: "src/agent/AgentLoop.js", body, tokens_full: 10 }]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ limit: "3" });

		await plugin.handler(entry, rummy);

		const result = store.upserted[0];
		assert.ok(result.body.startsWith("[lines 1–3 / 5 total]"));
		assert.ok(result.body.includes("a\nb\nc"));
		assert.ok(!result.body.includes("d"));
	});

	it("clamps end to total lines when limit exceeds file length", async () => {
		const body = "x\ny\nz";
		const store = makeStore([{ path: "src/agent/AgentLoop.js", body, tokens_full: 10 }]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ line: "2", limit: "999" });

		await plugin.handler(entry, rummy);

		const result = store.upserted[0];
		assert.ok(result.body.startsWith("[lines 2–3 / 3 total]"));
		assert.ok(result.body.includes("y\nz"));
	});

	it("glob with line/limit returns 400", async () => {
		const store = makeStore([]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ path: "src/**/*.js", line: "1", limit: "10" });

		await plugin.handler(entry, rummy);

		assert.strictEqual(store.upserted[0].status, 400);
	});

	it("not found with line/limit returns 200 not-found message", async () => {
		const store = makeStore([]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ line: "1", limit: "10" });

		await plugin.handler(entry, rummy);

		assert.strictEqual(store.upserted[0].status, 200);
		assert.ok(store.upserted[0].body.includes("not found"));
	});

	it("does not call promoteByPattern on partial read", async () => {
		const body = "a\nb\nc";
		let promoted = false;
		const store = {
			upserted: [],
			getEntriesByPattern: async () => [{ path: "src/agent/AgentLoop.js", body, tokens_full: 10 }],
			promoteByPattern: async () => { promoted = true; },
			setFidelity: async () => {},
			upsert: async (runId, turn, path, b, status) => {
				store.upserted.push({ path, body: b, status });
			},
		};
		const rummy = makeRummy(store);
		const entry = makeEntry({ line: "1", limit: "2" });

		await plugin.handler(entry, rummy);

		assert.strictEqual(promoted, false, "promoteByPattern must not be called on partial read");
	});
});
