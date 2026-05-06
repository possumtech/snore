import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import Stream from "./stream.js";

function makeCore() {
	const hooks = createHooks();
	const methods = new Map();
	hooks.rpc.registry = {
		register: (name, def) => methods.set(name, def),
	};
	return { hooks, _method: (n) => methods.get(n) };
}

function makeStore({ channels = [], attrs = {} } = {}) {
	const calls = [];
	return {
		_calls: calls,
		set: async (params) => calls.push(params),
		getEntriesByPattern: async () => channels,
		getAttributes: async () => attrs,
	};
}

const RUN_DB = (id = "r1") => ({
	get_run_by_alias: { get: async () => ({ id, alias: "test_run" }) },
	get_pending_loops: { all: async () => [] },
	get_latest_completed_loop: { get: async () => null },
});

describe("Stream plugin", () => {
	it("registers stream, stream/completed, stream/aborted, stream/cancel", () => {
		const core = makeCore();
		new Stream(core);
		for (const n of [
			"stream",
			"stream/completed",
			"stream/aborted",
			"stream/cancel",
		]) {
			assert.ok(core._method(n), `expected ${n} registered`);
			assert.equal(core._method(n).requiresInit, true);
		}
	});

	describe("stream", () => {
		it("validates required params", async () => {
			const core = makeCore();
			new Stream(core);
			const def = core._method("stream");
			await assert.rejects(def.handler({}, {}), /run is required/);
			await assert.rejects(def.handler({ run: "r" }, {}), /path is required/);
			await assert.rejects(
				def.handler({ run: "r", path: "log://turn_1/sh/x" }, {}),
				/channel is required/,
			);
			await assert.rejects(
				def.handler({ run: "r", path: "log://turn_1/sh/x", channel: 1 }, {}),
				/chunk is required/,
			);
		});

		it("rejects when path is not a log entry", async () => {
			const core = makeCore();
			new Stream(core);
			const def = core._method("stream");
			const store = makeStore();
			const ctx = {
				db: RUN_DB(),
				projectAgent: { entries: store },
			};
			await assert.rejects(
				def.handler({ run: "r", path: "set://x", channel: 1, chunk: "c" }, ctx),
				/path must be a log entry/,
			);
		});

		it("rejects unknown run alias", async () => {
			const core = makeCore();
			new Stream(core);
			const def = core._method("stream");
			const ctx = {
				db: { get_run_by_alias: { get: async () => null } },
				projectAgent: { entries: makeStore() },
			};
			await assert.rejects(
				def.handler(
					{ run: "missing", path: "log://turn_1/sh/x", channel: 1, chunk: "c" },
					ctx,
				),
				/run not found/,
			);
		});

		it("appends chunk to derived data-channel path", async () => {
			const core = makeCore();
			new Stream(core);
			const def = core._method("stream");
			const store = makeStore();
			const ctx = {
				db: RUN_DB(),
				projectAgent: { entries: store },
			};
			const result = await def.handler(
				{ run: "r", path: "log://turn_5/sh/run", channel: 1, chunk: "out" },
				ctx,
			);
			assert.deepEqual(result, { status: "ok" });
			assert.equal(store._calls[0].path, "sh://turn_5/run_1");
			assert.equal(store._calls[0].body, "out");
			assert.equal(store._calls[0].append, true);
		});
	});

	describe("stream/completed", () => {
		it("transitions all channels to resolved on exit_code=0 + writes log summary", async () => {
			const core = makeCore();
			new Stream(core);
			const def = core._method("stream/completed");
			const store = makeStore({
				channels: [
					{ path: "sh://turn_1/run_1", body: "out", tokens: 1 },
					{ path: "sh://turn_1/run_2", body: "", tokens: 0 },
				],
				attrs: { command: "ls" },
			});
			const ctx = {
				db: RUN_DB(),
				projectAgent: { entries: store },
			};
			const result = await def.handler(
				{ run: "r", path: "log://turn_1/sh/run", exit_code: 0, duration: "1s" },
				ctx,
			);
			assert.deepEqual(result, { ok: true, channels: 2, woke: false });
			const channelUpdates = store._calls.filter((c) =>
				c.path.startsWith("sh://"),
			);
			assert.equal(channelUpdates.length, 2);
			assert.ok(channelUpdates.every((c) => c.state === "resolved"));
			const logUpdate = store._calls.find(
				(c) => c.path === "log://turn_1/sh/run",
			);
			assert.match(logUpdate.body, /ran 'ls', exit=0 \(1s\)/);
			assert.match(logUpdate.body, /sh:\/\/turn_1\/run_1 \(1 tokens\)/);
		});

		it("transitions channels to failed on non-zero exit_code", async () => {
			const core = makeCore();
			new Stream(core);
			const def = core._method("stream/completed");
			const store = makeStore({
				channels: [{ path: "sh://turn_1/x_1", body: "err", tokens: 1 }],
				attrs: { summary: "ls" },
			});
			const ctx = {
				db: RUN_DB(),
				projectAgent: { entries: store },
			};
			await def.handler(
				{ run: "r", path: "log://turn_1/sh/x", exit_code: 2 },
				ctx,
			);
			const channelUpdate = store._calls.find((c) =>
				c.path.startsWith("sh://"),
			);
			assert.equal(channelUpdate.state, "failed");
			assert.equal(channelUpdate.outcome, "exit:2");
			const logUpdate = store._calls.find(
				(c) => c.path === "log://turn_1/sh/x",
			);
			assert.match(logUpdate.body, /exit=2/);
		});

		it("rejects when path is not a log entry", async () => {
			const core = makeCore();
			new Stream(core);
			const def = core._method("stream/completed");
			const ctx = {
				db: RUN_DB(),
				projectAgent: { entries: makeStore() },
			};
			await assert.rejects(
				def.handler({ run: "r", path: "bare://x" }, ctx),
				/path must be a log entry/,
			);
		});
	});

	describe("stream/aborted", () => {
		it("transitions channels to cancelled and rewrites log body with reason", async () => {
			const core = makeCore();
			new Stream(core);
			const def = core._method("stream/aborted");
			const store = makeStore({
				channels: [{ path: "sh://turn_1/x_1", body: "", tokens: 0 }],
				attrs: { command: "ls" },
			});
			const ctx = {
				db: RUN_DB(),
				projectAgent: { entries: store },
			};
			const result = await def.handler(
				{
					run: "r",
					path: "log://turn_1/sh/x",
					reason: "user cancelled",
					duration: "0.5s",
				},
				ctx,
			);
			assert.deepEqual(result, { status: "ok", channels: 1 });
			const ch = store._calls.find((c) => c.path.startsWith("sh://"));
			assert.equal(ch.state, "cancelled");
			assert.equal(ch.outcome, "user cancelled");
			const log = store._calls.find((c) => c.path === "log://turn_1/sh/x");
			assert.match(log.body, /aborted 'ls' \(user cancelled, 0\.5s\)/);
		});

		it("defaults outcome to 'aborted' when no reason given", async () => {
			const core = makeCore();
			new Stream(core);
			const def = core._method("stream/aborted");
			const store = makeStore({
				channels: [{ path: "sh://turn_1/x_1", body: "", tokens: 0 }],
				attrs: {},
			});
			const ctx = {
				db: RUN_DB(),
				projectAgent: { entries: store },
			};
			await def.handler({ run: "r", path: "log://turn_1/sh/x" }, ctx);
			const ch = store._calls.find((c) => c.path.startsWith("sh://"));
			assert.equal(ch.outcome, "aborted");
		});
	});

	describe("stream/cancel", () => {
		it("transitions channels + emits stream.cancelled notification", async () => {
			const core = makeCore();
			new Stream(core);
			const def = core._method("stream/cancel");
			let cancelled;
			core.hooks.stream.cancelled.on((evt) => {
				cancelled = evt;
			});
			const store = makeStore({
				channels: [{ path: "sh://turn_1/x_1", body: "", tokens: 0 }],
				attrs: { command: "ls" },
			});
			const ctx = {
				db: RUN_DB(),
				projectAgent: { entries: store },
				projectId: "p1",
			};
			const result = await def.handler(
				{ run: "r", path: "log://turn_1/sh/x", reason: "stale" },
				ctx,
			);
			assert.deepEqual(result, { ok: true, channels: 1 });
			assert.deepEqual(cancelled, {
				projectId: "p1",
				run: "r",
				path: "log://turn_1/sh/x",
				reason: "stale",
			});
		});
	});
});
