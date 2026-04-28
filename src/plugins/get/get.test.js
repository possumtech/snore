import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Get from "./get.js";

function makeStore(entries = []) {
	const upserted = [];
	return {
		upserted,
		getEntriesByPattern: async () => entries,
		get: async () => {},
		set: async ({ path, body, state, outcome, attributes }) => {
			upserted.push({
				path,
				body,
				state,
				outcome: outcome ?? null,
				attributes: attributes ?? null,
			});
		},
	};
}

function makeRummy(store, _attrs = {}) {
	const emitted = [];
	return {
		entries: store,
		sequence: 1,
		runId: 1,
		loopId: 1,
		hooks: {
			error: {
				log: {
					emit: async (payload) => emitted.push(payload),
				},
			},
		},
		_emitted: emitted,
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
		const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const store = makeStore([
			{ path: "src/agent/AgentLoop.js", body, tokens: 500 },
		]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ line: "10", limit: "5" });

		await plugin.handler(entry, rummy);

		assert.strictEqual(store.upserted.length, 1);
		const result = store.upserted[0];
		assert.strictEqual(result.state, "resolved");
		assert.ok(
			result.body.startsWith(
				"src/agent/AgentLoop.js\n[lines 10–14 / 100 total]",
			),
			`unexpected header: ${result.body.slice(0, 60)}`,
		);
		assert.ok(result.body.includes("line 10"));
		assert.ok(result.body.includes("line 14"));
		assert.ok(!result.body.includes("line 15"));
	});

	it("tags the slice log with lineStart/lineEnd/totalLines for renderLogTag", async () => {
		const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const store = makeStore([
			{ path: "src/agent/AgentLoop.js", body, tokens: 500 },
		]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ line: "10", limit: "5" });

		await plugin.handler(entry, rummy);

		const { attributes } = store.upserted[0];
		assert.strictEqual(attributes.path, "src/agent/AgentLoop.js");
		assert.strictEqual(attributes.lineStart, 10);
		assert.strictEqual(attributes.lineEnd, 14);
		assert.strictEqual(attributes.totalLines, 100);
	});

	it("limit only defaults start to line 1", async () => {
		const body = "a\nb\nc\nd\ne";
		const store = makeStore([
			{ path: "src/agent/AgentLoop.js", body, tokens: 10 },
		]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ limit: "3" });

		await plugin.handler(entry, rummy);

		const result = store.upserted[0];
		assert.ok(
			result.body.startsWith("src/agent/AgentLoop.js\n[lines 1–3 / 5 total]"),
		);
		assert.ok(result.body.includes("a\nb\nc"));
		assert.ok(!result.body.includes("d"));
	});

	it("negative line reads tail from end", async () => {
		const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const store = makeStore([
			{ path: "sh://turn_3/npm_test_1", body, tokens: 500 },
		]);
		const rummy = makeRummy(store);
		// line=-10 means "start 10 from the end" → lines 91..100
		const entry = makeEntry({
			path: "sh://turn_3/npm_test_1",
			line: "-10",
		});

		await plugin.handler(entry, rummy);

		const result = store.upserted[0];
		assert.ok(
			result.body.startsWith(
				"sh://turn_3/npm_test_1\n[lines 91–100 / 100 total]",
			),
			`unexpected header: ${result.body.slice(0, 60)}`,
		);
		assert.ok(result.body.includes("line 100"));
		assert.ok(result.body.includes("line 91"));
		assert.ok(!result.body.includes("line 90\n"));
	});

	it("negative line with limit reads a window from the end", async () => {
		const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		const store = makeStore([
			{ path: "sh://turn_3/npm_test_1", body, tokens: 500 },
		]);
		const rummy = makeRummy(store);
		// line=-20, limit=5 → start at line 81, show 5 lines (81..85)
		const entry = makeEntry({
			path: "sh://turn_3/npm_test_1",
			line: "-20",
			limit: "5",
		});

		await plugin.handler(entry, rummy);

		const result = store.upserted[0];
		assert.ok(
			result.body.startsWith(
				"sh://turn_3/npm_test_1\n[lines 81–85 / 100 total]",
			),
			`unexpected header: ${result.body.slice(0, 60)}`,
		);
		assert.ok(result.body.includes("line 81"));
		assert.ok(result.body.includes("line 85"));
		assert.ok(!result.body.includes("line 86"));
	});

	it("negative line clamps to line 1 when offset exceeds total", async () => {
		const body = "a\nb\nc";
		const store = makeStore([{ path: "x", body, tokens: 10 }]);
		const rummy = makeRummy(store);
		// line=-500 with only 3 lines clamps to line 1
		const entry = makeEntry({ path: "x", line: "-500" });

		await plugin.handler(entry, rummy);

		const result = store.upserted[0];
		assert.ok(result.body.startsWith("x\n[lines 1–3 / 3 total]"));
		assert.ok(result.body.includes("a\nb\nc"));
	});

	it("clamps end to total lines when limit exceeds file length", async () => {
		const body = "x\ny\nz";
		const store = makeStore([
			{ path: "src/agent/AgentLoop.js", body, tokens: 10 },
		]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ line: "2", limit: "999" });

		await plugin.handler(entry, rummy);

		const result = store.upserted[0];
		assert.ok(
			result.body.startsWith("src/agent/AgentLoop.js\n[lines 2–3 / 3 total]"),
		);
		assert.ok(result.body.includes("y\nz"));
	});

	it("glob with line/limit fails with validation outcome", async () => {
		const store = makeStore([]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ path: "src/**/*.js", line: "1", limit: "10" });

		await plugin.handler(entry, rummy);

		assert.strictEqual(store.upserted[0].state, "failed");
		assert.strictEqual(store.upserted[0].outcome, "validation");
	});

	it("not found with line/limit resolves with not-found message", async () => {
		const store = makeStore([]);
		const rummy = makeRummy(store);
		const entry = makeEntry({ line: "1", limit: "10" });

		await plugin.handler(entry, rummy);

		assert.strictEqual(store.upserted[0].state, "resolved");
		assert.ok(store.upserted[0].body.includes("not found"));
	});

	describe("missing path validation (@error_recovery)", () => {
		it("finalizes the action entry as state=failed with an actionable body", async () => {
			const store = makeStore([]);
			const rummy = makeRummy(store);
			const entry = { attributes: {}, resultPath: "get://result" };

			await plugin.handler(entry, rummy);

			assert.strictEqual(
				rummy._emitted.length,
				0,
				"no error.log emission — action entry IS its outcome",
			);
			assert.strictEqual(
				store.upserted.length,
				1,
				"exactly one write — the action entry's failed outcome",
			);
			const written = store.upserted[0];
			assert.strictEqual(written.path, "get://result");
			assert.strictEqual(written.state, "failed");
			assert.strictEqual(written.outcome, "validation");
			assert.ok(
				written.body.includes("path"),
				`body mentions path; got: ${written.body}`,
			);
			assert.ok(
				written.body.includes('<get path="'),
				`body shows correct syntax; got: ${written.body}`,
			);
		});
	});

	it("does not call get (promote) on partial read", async () => {
		const body = "a\nb\nc";
		let promoted = false;
		const store = {
			upserted: [],
			getEntriesByPattern: async () => [
				{ path: "src/agent/AgentLoop.js", body, tokens: 10 },
			],
			get: async () => {
				promoted = true;
			},
			set: async ({ path, body: b, state }) => {
				store.upserted.push({ path, body: b, state });
			},
		};
		const rummy = makeRummy(store);
		const entry = makeEntry({ line: "1", limit: "2" });

		await plugin.handler(entry, rummy);

		assert.strictEqual(
			promoted,
			false,
			"store.get must not be called on partial read",
		);
	});
});
