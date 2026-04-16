/**
 * E2E: Streaming shell/env pipeline.
 *
 * Exercises the full server-side protocol for streaming producers
 * without requiring a live LLM — the test manually seeds the sh
 * proposal that the model would ordinarily emit, then drives the
 * accept + stream + completion flow through real RPC calls on a real
 * WebSocket server.
 *
 * Why manual seeding: the LLM decision to emit <sh> is its own
 * concern, tested elsewhere in stories. The streaming-specific
 * behavior is the resolve() branch, the stream/stream-completed RPCs,
 * and the lifecycle transitions (202→200 log, 102→200 data channels).
 * This test targets exactly that slice of the pipeline.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E: Streaming", { concurrency: 1 }, () => {
	let tdb, tserver, client;

	before(async () => {
		tdb = await TestDb.create("streaming_e2e");
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
		await client.call("init", {
			name: "StreamingTest",
			projectRoot: "/tmp",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
	});

	async function seedShProposal(runAlias, slug, command) {
		// Seed an sh:// proposal in the DB matching what sh.handler would
		// produce on model emission. Allows us to test the accept→stream
		// flow without invoking the LLM.
		const runRow = await tdb.db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow) throw new Error(`run not found: ${runAlias}`);
		const path = `sh://turn_1/${slug}`;
		await tdb.db.upsert_known_entry.run({
			run_id: runRow.id,
			loop_id: null,
			turn: 1,
			path,
			body: "",
			status: 202,
			fidelity: "demoted",
			hash: null,
			attributes: JSON.stringify({
				command,
				summary: command,
			}),
			updated_at: null,
		});
		return path;
	}

	async function allEntries(runAlias) {
		const runRow = await tdb.db.get_run_by_alias.get({ alias: runAlias });
		return tdb.db.get_known_entries.all({ run_id: runRow.id });
	}

	it("accept creates _1 and _2 data channels at status 102", async () => {
		const start = await client.call("startRun", { model: "gemma" });
		const run = start.run;
		const path = await seedShProposal(run, "echo_test", "echo hello");

		await client.call("run/resolve", {
			run,
			resolution: { path, action: "accept" },
		});

		const entries = await allEntries(run);
		const logEntry = entries.find((e) => e.path === path);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);
		const stderrEntry = entries.find((e) => e.path === `${path}_2`);

		assert.ok(logEntry, "log entry exists");
		assert.strictEqual(logEntry.status, 200, "log entry transitioned to 200");
		assert.ok(
			logEntry.body.includes("echo hello"),
			`log body mentions command: ${logEntry.body}`,
		);
		assert.ok(
			logEntry.body.includes(`${path}_1`),
			"log body references stdout channel",
		);

		assert.ok(stdoutEntry, "_1 entry exists");
		assert.strictEqual(stdoutEntry.status, 102, "_1 at status 102");
		assert.strictEqual(stdoutEntry.body, "", "_1 body empty");
		assert.strictEqual(stdoutEntry.fidelity, "demoted", "_1 demoted");

		assert.ok(stderrEntry, "_2 entry exists");
		assert.strictEqual(stderrEntry.status, 102, "_2 at status 102");
	});

	it("stream RPC appends chunks to the right channel", async () => {
		const start = await client.call("startRun", { model: "gemma" });
		const run = start.run;
		const path = await seedShProposal(run, "append_test", "seq 1 3");
		await client.call("run/resolve", {
			run,
			resolution: { path, action: "accept" },
		});

		// Stream stdout chunks
		await client.call("stream", {
			run,
			path,
			channel: 1,
			chunk: "line 1\n",
		});
		await client.call("stream", {
			run,
			path,
			channel: 1,
			chunk: "line 2\n",
		});
		await client.call("stream", {
			run,
			path,
			channel: 1,
			chunk: "line 3\n",
		});

		// Stream a stderr chunk too
		await client.call("stream", {
			run,
			path,
			channel: 2,
			chunk: "warning: something\n",
		});

		const entries = await allEntries(run);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);
		const stderrEntry = entries.find((e) => e.path === `${path}_2`);

		assert.strictEqual(stdoutEntry.body, "line 1\nline 2\nline 3\n");
		assert.strictEqual(stdoutEntry.status, 102, "still running during stream");
		assert.ok(stdoutEntry.tokens > 0, "tokens recomputed");

		assert.strictEqual(stderrEntry.body, "warning: something\n");
	});

	it("stream/completed transitions channels to 200 on exit_code=0", async () => {
		const start = await client.call("startRun", { model: "gemma" });
		const run = start.run;
		const path = await seedShProposal(run, "success_test", "true");
		await client.call("run/resolve", {
			run,
			resolution: { path, action: "accept" },
		});

		await client.call("stream", {
			run,
			path,
			channel: 1,
			chunk: "output\n",
		});
		await client.call("stream/completed", {
			run,
			path,
			exit_code: 0,
			duration: "0.1s",
		});

		const entries = await allEntries(run);
		const logEntry = entries.find((e) => e.path === path);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);
		const stderrEntry = entries.find((e) => e.path === `${path}_2`);

		assert.strictEqual(stdoutEntry.status, 200, "stdout transitioned to 200");
		assert.strictEqual(stderrEntry.status, 200, "stderr transitioned to 200");

		assert.ok(
			logEntry.body.includes("exit=0"),
			`log body has exit code: ${logEntry.body}`,
		);
		assert.ok(
			logEntry.body.includes("0.1s"),
			`log body has duration: ${logEntry.body}`,
		);
	});

	it("stream/completed transitions channels to 500 on non-zero exit_code", async () => {
		const start = await client.call("startRun", { model: "gemma" });
		const run = start.run;
		const path = await seedShProposal(run, "failure_test", "false");
		await client.call("run/resolve", {
			run,
			resolution: { path, action: "accept" },
		});

		await client.call("stream", {
			run,
			path,
			channel: 2,
			chunk: "error output\n",
		});
		await client.call("stream/completed", {
			run,
			path,
			exit_code: 1,
		});

		const entries = await allEntries(run);
		const logEntry = entries.find((e) => e.path === path);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);
		const stderrEntry = entries.find((e) => e.path === `${path}_2`);

		assert.strictEqual(stdoutEntry.status, 500, "stdout transitioned to 500");
		assert.strictEqual(stderrEntry.status, 500, "stderr transitioned to 500");

		assert.ok(
			logEntry.body.includes("exit=1"),
			`log body has exit code: ${logEntry.body}`,
		);
	});

	it("stream/aborted transitions channels to 499 with abort body", async () => {
		const start = await client.call("startRun", { model: "gemma" });
		const run = start.run;
		const path = await seedShProposal(run, "abort_test", "sleep 60");
		await client.call("run/resolve", {
			run,
			resolution: { path, action: "accept" },
		});

		await client.call("stream", {
			run,
			path,
			channel: 1,
			chunk: "partial output\n",
		});
		await client.call("stream/aborted", {
			run,
			path,
			reason: "user cancelled",
			duration: "0.3s",
		});

		const entries = await allEntries(run);
		const logEntry = entries.find((e) => e.path === path);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);
		const stderrEntry = entries.find((e) => e.path === `${path}_2`);

		assert.strictEqual(stdoutEntry.status, 499, "stdout transitioned to 499");
		assert.strictEqual(stderrEntry.status, 499, "stderr transitioned to 499");
		assert.strictEqual(
			stdoutEntry.body,
			"partial output\n",
			"stdout body preserved on abort",
		);

		assert.ok(
			logEntry.body.startsWith("aborted "),
			`log body notes abort: ${logEntry.body}`,
		);
		assert.ok(
			logEntry.body.includes("user cancelled"),
			`log body has reason: ${logEntry.body}`,
		);
		assert.ok(
			logEntry.body.includes("0.3s"),
			`log body has duration: ${logEntry.body}`,
		);
		assert.ok(
			logEntry.body.includes(`${path}_1`),
			"log body references channel",
		);
	});

	it("stream/aborted works without reason or duration", async () => {
		const start = await client.call("startRun", { model: "gemma" });
		const run = start.run;
		const path = await seedShProposal(run, "abort_bare", "yes");
		await client.call("run/resolve", {
			run,
			resolution: { path, action: "accept" },
		});

		await client.call("stream/aborted", { run, path });

		const entries = await allEntries(run);
		const logEntry = entries.find((e) => e.path === path);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);

		assert.strictEqual(stdoutEntry.status, 499);
		assert.ok(logEntry.body.startsWith("aborted 'yes'"));
	});

	it("env scheme follows identical streaming pattern", async () => {
		const start = await client.call("startRun", { model: "gemma" });
		const run = start.run;

		const runRow = await tdb.db.get_run_by_alias.get({ alias: run });
		const path = `env://turn_1/pwd`;
		await tdb.db.upsert_known_entry.run({
			run_id: runRow.id,
			loop_id: null,
			turn: 1,
			path,
			body: "",
			status: 202,
			fidelity: "demoted",
			hash: null,
			attributes: JSON.stringify({
				command: "pwd",
				summary: "pwd",
			}),
			updated_at: null,
		});

		await client.call("run/resolve", {
			run,
			resolution: { path, action: "accept" },
		});
		await client.call("stream", {
			run,
			path,
			channel: 1,
			chunk: "/tmp\n",
		});
		await client.call("stream/completed", { run, path, exit_code: 0 });

		const entries = await allEntries(run);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);

		assert.ok(stdoutEntry, "env _1 entry exists");
		assert.strictEqual(stdoutEntry.status, 200);
		assert.strictEqual(stdoutEntry.body, "/tmp\n");
	});

	it("stream requires all params (run, path, channel, chunk)", async () => {
		const start = await client.call("startRun", { model: "gemma" });
		const run = start.run;

		await assert.rejects(
			() => client.call("stream", { run, path: "sh://x", channel: 1 }),
			/chunk is required/,
		);
		await assert.rejects(
			() =>
				client.call("stream", {
					run,
					path: "sh://x",
					chunk: "c",
				}),
			/channel is required/,
		);
		await assert.rejects(
			() => client.call("stream", { run, channel: 1, chunk: "c" }),
			/path is required/,
		);
	});
});
