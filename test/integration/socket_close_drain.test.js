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
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const N_RUNS = 5;
const TERMINAL = new Set([200, 204, 413, 422, 499, 500]);

describe("SocketServer close() drains in-flight runs (@run_state_machine)", () => {
	let tdb, tserver, inFlight, projectRoot;

	before(async () => {
		tdb = await TestDb.create("close_drain");
		inFlight = { count: 0 };
		// Empty isolated tempdir as project root. Walking /tmp directly
		// would ingest thousands of files and dominate dispatch latency.
		projectRoot = await fs.mkdtemp(join(tmpdir(), "rummy_close_drain_"));

		// Stub provider whose completion hangs until the AbortSignal fires.
		// Lets us start runs that won't resolve on their own; close() must
		// abort them via the chain server.close → conn.shutdown →
		// projectAgent.shutdown → agentLoop.abortAll.
		// `inFlight.count` increments when completion is reached and decrements
		// on abort — gives the test a deterministic signal that dispatch has
		// progressed past startup into the LLM-call hang.
		tdb.hooks.llm.providers.push({
			name: "stub-hang",
			matches: (wire) => wire === "stub-hang",
			completion: (_messages, _model, { signal } = {}) =>
				new Promise((_, reject) => {
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					inFlight.count++;
					signal?.addEventListener(
						"abort",
						() => {
							inFlight.count--;
							reject(new Error("aborted"));
						},
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
		if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true });
	});

	it(`close() awaits in-flight runs and brings ${N_RUNS} all to terminal`, async () => {
		const clients = [];
		const aliases = [];

		for (let i = 0; i < N_RUNS; i++) {
			const client = new RpcClient(tserver.url);
			await client.connect();
			await client.call("rummy/hello", {
				name: `drain-${i}`,
				projectRoot,
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

		// Wait until every run has reached the LLM-call hang (deterministic,
		// not timing-based). Without this, close() may race past dispatch
		// startup before runs are genuinely in-flight, draining nothing.
		const deadline = Date.now() + 5000;
		while (inFlight.count < N_RUNS && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		assert.strictEqual(
			inFlight.count,
			N_RUNS,
			`only ${inFlight.count}/${N_RUNS} runs reached LLM-call hang within 5s`,
		);

		// Close mid-flight. Must abort each run's AbortSignal, await the
		// stub rejection, and transition every run to a terminal status.
		await tserver.stop();

		// Drain contract: every signal was fired and every run terminated.
		assert.strictEqual(
			inFlight.count,
			0,
			`${inFlight.count} runs still in-flight after close()`,
		);
		for (const alias of aliases) {
			const row = await tdb.db.get_run_by_alias.get({ alias });
			assert.ok(row, `run ${alias} exists`);
			assert.ok(
				TERMINAL.has(row.status),
				`run ${alias} status ${row.status} not terminal`,
			);
		}

		for (const c of clients) c.close();
	});
});
