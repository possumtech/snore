/**
 * SocketServer.close() drain — concurrency correctness.
 *
 * Covers @run_state_machine, @plugins_rpc_run_lifecycle.
 *
 * Locks in the abortAll() chain: server.close() awaits in-flight runs,
 * every run lands at a terminal status, and no Promises pin the event
 * loop after close resolves (verified implicitly: the test process
 * completes its `after` hook within the runner timeout).
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const N_RUNS = 5;
const TERMINAL = new Set([200, 204, 413, 422, 499, 500]);

describe("SocketServer close() drains in-flight runs (@run_state_machine)", () => {
	let tdb, tserver;

	before(async () => {
		tdb = await TestDb.create("close_drain");

		// Stub provider whose completion hangs until the AbortSignal fires.
		// Lets us start runs that won't resolve on their own; close() must
		// abort them via the chain server.close → conn.shutdown →
		// projectAgent.shutdown → agentLoop.abortAll.
		tdb.hooks.llm.providers.push({
			name: "stub-hang",
			matches: (wire) => wire === "stub-hang",
			completion: (_messages, _model, { signal } = {}) =>
				new Promise((_, reject) => {
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					signal?.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					);
				}),
			getContextSize: async () => 32768,
		});

		await tdb.db.upsert_model.get({
			alias: "stub-hang",
			actual: "stub-hang",
			context_length: 32768,
		});

		tserver = await TestServer.start(tdb);
	});

	after(async () => {
		await tdb?.cleanup();
	});

	it(`close() awaits in-flight runs and brings ${N_RUNS} all to terminal`, async () => {
		const clients = [];
		const aliases = [];

		for (let i = 0; i < N_RUNS; i++) {
			const client = new RpcClient(tserver.url);
			await client.connect();
			await client.call("rummy/hello", {
				name: `drain-${i}`,
				projectRoot: "/tmp",
				clientVersion: "2.0.0",
			});
			const res = await client.call("set", {
				path: "run://",
				body: `drain test ${i}`,
				attributes: { model: "stub-hang", mode: "ask" },
			});
			aliases.push(res.alias);
			clients.push(client);
		}

		// Let dispatch reach the LLM call (where it'll hang on the stub).
		await new Promise((r) => setTimeout(r, 200));

		// Close mid-flight. Should await every run's drain, not return
		// while runs are still resolving.
		const closeStart = Date.now();
		await tserver.stop();
		const closeDuration = Date.now() - closeStart;

		// Every run must have reached terminal status. abortAll triggered
		// each run's AbortSignal, the stub provider rejected, and the
		// AgentLoop transitioned each run to a terminal HTTP status.
		for (const alias of aliases) {
			const row = await tdb.db.get_run_by_alias.get({ alias });
			assert.ok(row, `run ${alias} exists`);
			assert.ok(
				TERMINAL.has(row.status),
				`run ${alias} status ${row.status} not terminal`,
			);
		}

		// close() did real work (drain), not a no-op fast path.
		assert.ok(
			closeDuration > 0,
			`close() returned in ${closeDuration}ms — expected real drain`,
		);

		for (const c of clients) c.close();
	});
});
