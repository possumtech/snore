import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Cp from "./cp.js";

function stubCore() {
	return {
		registerScheme() {},
		on() {},
		filter() {},
	};
}

function makeStore({ bodies = {}, attributes = {} } = {}) {
	const calls = [];
	return {
		_calls: calls,
		async set(args) {
			calls.push(args);
		},
		async getBody(_runId, path) {
			return path in bodies ? bodies[path] : null;
		},
		async getAttributes(_runId, path) {
			return path in attributes ? attributes[path] : null;
		},
	};
}

describe("Cp", () => {
	it("full renders cp from and to", () => {
		const plugin = new Cp(stubCore());
		const result = plugin.full({ attributes: { from: "a", to: "b" } });
		assert.ok(result.includes("a"));
		assert.ok(result.includes("b"));
	});

	describe("handler — bare-file destination materialization", () => {
		it("emits proposed entry with attrs.path + attrs.patched for shared materializer", async () => {
			const plugin = new Cp(stubCore());
			const store = makeStore({
				bodies: { "https://x.example/page": "fetched body content" },
			});
			await plugin.handler(
				{
					attributes: { path: "https://x.example/page", to: "src/out.c" },
					resultPath: "log://turn_1/cp/x",
				},
				{ entries: store, sequence: 1, runId: "r", loopId: "l" },
			);
			const proposal = store._calls.find((c) => c.path === "log://turn_1/cp/x");
			assert.ok(proposal);
			assert.equal(proposal.state, "proposed");
			assert.equal(proposal.attributes.path, "src/out.c");
			assert.equal(
				proposal.attributes.patched,
				"fetched body content",
				"patched carries the source body",
			);
		});

		it("when destination already exists, patched holds the source body that overwrites", async () => {
			const plugin = new Cp(stubCore());
			const store = makeStore({
				bodies: {
					"https://x.example/page": "new",
					"src/out.c": "old",
				},
			});
			await plugin.handler(
				{
					attributes: { path: "https://x.example/page", to: "src/out.c" },
					resultPath: "log://turn_1/cp/x",
				},
				{ entries: store, sequence: 1, runId: "r", loopId: "l" },
			);
			const proposal = store._calls.find((c) => c.path === "log://turn_1/cp/x");
			assert.equal(proposal.attributes.patched, "new");
			assert.match(proposal.attributes.warning, /Overwrote/);
		});

		it("preserves existing from/to/isMove attrs alongside path/patched", async () => {
			const plugin = new Cp(stubCore());
			const store = makeStore({ bodies: { "src/a": "content" } });
			await plugin.handler(
				{
					attributes: { path: "src/a", to: "src/b" },
					resultPath: "log://turn_1/cp/x",
				},
				{ entries: store, sequence: 1, runId: "r", loopId: "l" },
			);
			const proposal = store._calls.find((c) => c.path === "log://turn_1/cp/x");
			assert.equal(proposal.attributes.from, "src/a");
			assert.equal(proposal.attributes.to, "src/b");
			assert.equal(proposal.attributes.isMove, false);
		});
	});

	describe("handler — schemed destination (immediate resolution)", () => {
		it("writes source body to schemed destination + resolved log entry", async () => {
			const plugin = new Cp(stubCore());
			const store = makeStore({ bodies: { "src/a.js": "source code" } });
			await plugin.handler(
				{
					attributes: { path: "src/a.js", to: "known://archive" },
					resultPath: "log://turn_1/cp/x",
				},
				{ entries: store, sequence: 1, runId: "r", loopId: "l" },
			);
			const dest = store._calls.find((c) => c.path === "known://archive");
			assert.ok(dest);
			assert.equal(dest.body, "source code");
			assert.equal(dest.state, "resolved");
			const log = store._calls.find((c) => c.path === "log://turn_1/cp/x");
			assert.equal(log.state, "resolved");
		});

		it("propagates source's tags to destination when no explicit tags=", async () => {
			const plugin = new Cp(stubCore());
			const store = makeStore({
				bodies: { "known://draft": "body" },
				attributes: { "known://draft": { tags: "geography,france" } },
			});
			await plugin.handler(
				{
					attributes: { path: "known://draft", to: "known://archive/draft" },
					resultPath: "log://turn_1/cp/x",
				},
				{ entries: store, sequence: 1, runId: "r", loopId: "l" },
			);
			const dest = store._calls.find((c) => c.path === "known://archive/draft");
			assert.equal(dest.attributes.tags, "geography,france");
		});

		it("explicit tags= on cp wins over source tags", async () => {
			const plugin = new Cp(stubCore());
			const store = makeStore({
				bodies: { "known://draft": "body" },
				attributes: { "known://draft": { tags: "old,tags" } },
			});
			await plugin.handler(
				{
					attributes: {
						path: "known://draft",
						to: "known://archive/draft",
						tags: "new,tags",
					},
					resultPath: "log://turn_1/cp/x",
				},
				{ entries: store, sequence: 1, runId: "r", loopId: "l" },
			);
			const dest = store._calls.find((c) => c.path === "known://archive/draft");
			assert.equal(dest.attributes.tags, "new,tags");
		});
	});

	it("handler is a no-op when source body is missing", async () => {
		const plugin = new Cp(stubCore());
		const store = makeStore({ bodies: {} });
		await plugin.handler(
			{
				attributes: { path: "missing://thing", to: "src/x" },
				resultPath: "log://turn_1/cp/x",
			},
			{ entries: store, sequence: 1, runId: "r", loopId: "l" },
		);
		assert.equal(store._calls.length, 0);
	});

	it("manifest: lists matched sources without copying", async () => {
		const plugin = new Cp(stubCore());
		const matches = [
			{ path: "known://plan_a", scheme: "known", tokens: 80 },
			{ path: "known://plan_b", scheme: "known", tokens: 120 },
		];
		const store = {
			_calls: [],
			async set(args) {
				this._calls.push(args);
			},
			async getEntriesByPattern() {
				return matches;
			},
			async getBody() {
				throw new Error("manifest must not read source body");
			},
			async logPath(_r, t, s, p) {
				return `log://turn_${t}/${s}/${encodeURIComponent(p)}`;
			},
		};
		await plugin.handler(
			{
				attributes: {
					path: "known://plan_*",
					to: "known://archive_",
					manifest: "",
				},
				resultPath: "cp://result",
			},
			{ entries: store, sequence: 1, runId: "r", loopId: "l" },
		);
		const log = store._calls.find((c) => c.path?.startsWith("log://"));
		assert.ok(log, "wrote a manifest log entry");
		assert.match(log.body, /^MANIFEST cp path="known:\/\/plan_\*": 2 matched/);
		assert.ok(log.body.includes("known://plan_a"));
		assert.ok(log.body.includes("known://plan_b"));
	});
});
