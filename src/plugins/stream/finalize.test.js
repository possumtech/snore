import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import finalizeStream from "./finalize.js";

function makeEntries({ channels = [], logAttrs = null } = {}) {
	const calls = [];
	return {
		_calls: calls,
		set: async (params) => {
			calls.push(params);
		},
		getEntriesByPattern: async () => channels,
		getAttributes: async () => logAttrs,
	};
}

function makeDb({ pendingLoops = [], latestLoop = null } = {}) {
	return {
		get_pending_loops: { all: async () => pendingLoops },
		get_latest_completed_loop: { get: async () => latestLoop },
	};
}

describe("finalizeStream", () => {
	const runRow = { id: 7, alias: "run_7" };
	const path = "log://turn_1/sh/cmd";

	it("sets channel terminal states to resolved on exit 0", async () => {
		const channels = [
			{ path: "sh://turn_1/cmd_1", body: "out", tokens: 1 },
			{ path: "sh://turn_1/cmd_2", body: "", tokens: 0 },
		];
		const entries = makeEntries({ channels });
		const db = makeDb();
		const hooks = createHooks();

		await finalizeStream({
			db,
			entries,
			hooks,
			runRow,
			path,
			exitCode: 0,
			duration: "1s",
		});

		const channelSets = entries._calls.filter((c) =>
			c.path?.startsWith("sh://"),
		);
		assert.equal(channelSets.length, 2);
		assert.ok(channelSets.every((c) => c.state === "resolved"));
		assert.ok(channelSets.every((c) => c.outcome === null));
	});

	it("sets channel terminal states to failed on non-zero exit", async () => {
		const channels = [{ path: "sh://turn_1/cmd_1", body: "", tokens: 0 }];
		const entries = makeEntries({ channels });
		const db = makeDb();
		const hooks = createHooks();

		await finalizeStream({
			db,
			entries,
			hooks,
			runRow,
			path,
			exitCode: 7,
		});

		const ch = entries._calls.find((c) => c.path === "sh://turn_1/cmd_1");
		assert.equal(ch.state, "failed");
		assert.equal(ch.outcome, "exit:7");
	});

	it("rewrites the log entry with command, exit, duration, and channel summary", async () => {
		const channels = [
			{ path: "sh://turn_1/cmd_1", body: "hi", tokens: 5 },
			{ path: "sh://turn_1/cmd_2", body: "", tokens: 0 },
		];
		const entries = makeEntries({
			channels,
			logAttrs: { command: "echo hi" },
		});
		const db = makeDb();
		const hooks = createHooks();

		await finalizeStream({
			db,
			entries,
			hooks,
			runRow,
			path,
			exitCode: 0,
			duration: "1s",
		});

		const logSet = entries._calls.find((c) => c.path === path);
		assert.ok(logSet);
		assert.equal(logSet.state, "resolved");
		assert.match(logSet.body, /ran 'echo hi', exit=0 \(1s\)/);
		assert.match(logSet.body, /sh:\/\/turn_1\/cmd_1 \(5 tokens\)/);
		assert.match(logSet.body, /sh:\/\/turn_1\/cmd_2 \(empty\)/);
	});

	it("emits run.wake on a dormant run with the latest loop's mode", async () => {
		const channels = [{ path: "sh://turn_1/cmd_1", body: "", tokens: 0 }];
		const entries = makeEntries({ channels });
		const db = makeDb({
			pendingLoops: [],
			latestLoop: { id: 3, sequence: 2, mode: "act", status: 200 },
		});
		const hooks = createHooks();

		const woke = [];
		hooks.run.wake.on((evt) => woke.push(evt));

		const result = await finalizeStream({
			db,
			entries,
			hooks,
			runRow,
			path,
		});

		assert.equal(result.woke, true);
		assert.equal(woke.length, 1);
		assert.equal(woke[0].runAlias, "run_7");
		assert.equal(woke[0].body, "Process complete");
		assert.equal(woke[0].mode, "act");
	});

	it("does not wake when an active loop exists on the run", async () => {
		const channels = [{ path: "sh://turn_1/cmd_1", body: "", tokens: 0 }];
		const entries = makeEntries({ channels });
		const db = makeDb({
			pendingLoops: [{ id: 4, status: 102 }],
			latestLoop: { id: 3, sequence: 2, mode: "act", status: 200 },
		});
		const hooks = createHooks();

		const woke = [];
		hooks.run.wake.on((evt) => woke.push(evt));

		const result = await finalizeStream({
			db,
			entries,
			hooks,
			runRow,
			path,
		});

		assert.equal(result.woke, false);
		assert.equal(woke.length, 0);
	});

	it("does not wake when wake=false (abort/cancel paths)", async () => {
		const channels = [{ path: "sh://turn_1/cmd_1", body: "", tokens: 0 }];
		const entries = makeEntries({ channels });
		const db = makeDb({
			pendingLoops: [],
			latestLoop: { id: 3, sequence: 2, mode: "act", status: 200 },
		});
		const hooks = createHooks();

		const woke = [];
		hooks.run.wake.on((evt) => woke.push(evt));

		const result = await finalizeStream({
			db,
			entries,
			hooks,
			runRow,
			path,
			wake: false,
		});

		assert.equal(result.woke, undefined);
		assert.equal(woke.length, 0);
	});

	it("does not wake when there is no completed loop on the run", async () => {
		const channels = [{ path: "sh://turn_1/cmd_1", body: "", tokens: 0 }];
		const entries = makeEntries({ channels });
		const db = makeDb({ pendingLoops: [], latestLoop: null });
		const hooks = createHooks();

		const woke = [];
		hooks.run.wake.on((evt) => woke.push(evt));

		const result = await finalizeStream({
			db,
			entries,
			hooks,
			runRow,
			path,
		});

		assert.equal(result.woke, false);
		assert.equal(woke.length, 0);
	});

	it("throws on a non-log path", async () => {
		const entries = makeEntries();
		const db = makeDb();
		const hooks = createHooks();

		await assert.rejects(
			finalizeStream({
				db,
				entries,
				hooks,
				runRow,
				path: "bogus://nope",
			}),
			/path must be a log entry/,
		);
	});
});
