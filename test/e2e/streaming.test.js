/**
 * E2E: Streaming shell/env pipeline.
 *
 * Covers @streaming_entries, @resolution — exercises the full
 * server-side protocol for streaming producers without requiring a
 * live LLM — the test manually seeds the sh
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
import { stateToStatus } from "../../src/agent/httpStatus.js";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E: Streaming", { concurrency: 1 }, () => {
	let tdb, tserver, client;

	before(async () => {
		tdb = await TestDb.create("streaming_e2e");
		tserver = await TestServer.start(tdb);
		client = new AuditClient(tserver.url, tdb.db);
		await client.connect();
		await client.call("rummy/hello", {
			name: "StreamingTest",
			projectRoot: "/tmp",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
	});

	// Seed a proposal entry at the given path directly in the DB, matching
	// what the tool handler would produce on model emission. Allows us to
	// test the accept→stream flow without invoking the LLM. Writes the
	// entries row and a run_views row in `proposed` state.
	async function seedProposal(runAlias, path, attributes) {
		const runRow = await tdb.db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow) throw new Error(`run not found: ${runAlias}`);
		const entryRow = await tdb.db.upsert_entry.get({
			scope: `run:${runRow.id}`,
			path,
			body: "",
			attributes: JSON.stringify(attributes),
			hash: null,
		});
		await tdb.db.upsert_run_view.run({
			run_id: runRow.id,
			entry_id: entryRow.id,
			loop_id: null,
			turn: 1,
			state: "proposed",
			outcome: null,
			visibility: "summarized",
		});
		return path;
	}

	async function seedShProposal(runAlias, slug, command) {
		const path = `sh://turn_1/${slug}`;
		return seedProposal(runAlias, path, { command, summary: command });
	}

	async function startRun(model = "gemma") {
		const res = await client.startRun({ model, mode: "ask", prompt: "" });
		return res.run;
	}

	async function accept(run, path) {
		return client.resolveProposal(run, { path, action: "accept" });
	}

	async function allEntries(runAlias) {
		const runRow = await tdb.db.get_run_by_alias.get({ alias: runAlias });
		return tdb.db.get_known_entries.all({ run_id: runRow.id });
	}

	// Translate the view's text state+outcome to the numeric status the
	// model-facing tags carry. Tests assert on the same protocol shape
	// the RPC emits, not the internal storage vocabulary.
	const status = (entry) => stateToStatus(entry.state, entry.outcome);

	it("accept creates _1 and _2 data channels at status 102", async () => {
		const run = await startRun();
		const path = await seedShProposal(run, "echo_test", "echo hello");

		await accept(run, path);

		const entries = await allEntries(run);
		const logEntry = entries.find((e) => e.path === path);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);
		const stderrEntry = entries.find((e) => e.path === `${path}_2`);

		assert.ok(logEntry, "log entry exists");
		assert.strictEqual(status(logEntry), 200, "log entry transitioned to 200");
		assert.ok(
			logEntry.body.includes("echo hello"),
			`log body mentions command: ${logEntry.body}`,
		);
		assert.ok(
			logEntry.body.includes(`${path}_1`),
			"log body references stdout channel",
		);

		assert.ok(stdoutEntry, "_1 entry exists");
		assert.strictEqual(status(stdoutEntry), 102, "_1 at status 102");
		assert.strictEqual(stdoutEntry.body, "", "_1 body empty");
		assert.strictEqual(stdoutEntry.visibility, "summarized", "_1 demoted");

		assert.ok(stderrEntry, "_2 entry exists");
		assert.strictEqual(status(stderrEntry), 102, "_2 at status 102");
	});

	it("stream RPC appends chunks to the right channel", async () => {
		const run = await startRun();
		const path = await seedShProposal(run, "append_test", "seq 1 3");
		await accept(run, path);

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
		assert.strictEqual(status(stdoutEntry), 102, "still running during stream");
		assert.ok(stdoutEntry.tokens > 0, "tokens recomputed");

		assert.strictEqual(stderrEntry.body, "warning: something\n");
	});

	it("stream/completed transitions channels to 200 on exit_code=0", async () => {
		const run = await startRun();
		const path = await seedShProposal(run, "success_test", "true");
		await accept(run, path);

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

		assert.strictEqual(status(stdoutEntry), 200, "stdout transitioned to 200");
		assert.strictEqual(status(stderrEntry), 200, "stderr transitioned to 200");

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
		const run = await startRun();
		const path = await seedShProposal(run, "failure_test", "false");
		await accept(run, path);

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

		assert.strictEqual(status(stdoutEntry), 500, "stdout transitioned to 500");
		assert.strictEqual(status(stderrEntry), 500, "stderr transitioned to 500");

		assert.ok(
			logEntry.body.includes("exit=1"),
			`log body has exit code: ${logEntry.body}`,
		);
	});

	it("stream/aborted transitions channels to 499 with abort body", async () => {
		const run = await startRun();
		const path = await seedShProposal(run, "abort_test", "sleep 60");
		await accept(run, path);

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

		assert.strictEqual(status(stdoutEntry), 499, "stdout transitioned to 499");
		assert.strictEqual(status(stderrEntry), 499, "stderr transitioned to 499");
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
		const run = await startRun();
		const path = await seedShProposal(run, "abort_bare", "yes");
		await accept(run, path);

		await client.call("stream/aborted", { run, path });

		const entries = await allEntries(run);
		const logEntry = entries.find((e) => e.path === path);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);

		assert.strictEqual(status(stdoutEntry), 499);
		assert.ok(logEntry.body.startsWith("aborted 'yes'"));
	});

	it("stream/cancel transitions channels to 499 server-side", async () => {
		const run = await startRun();
		const path = await seedShProposal(run, "cancel_test", "make build");
		await accept(run, path);

		await client.call("stream", {
			run,
			path,
			channel: 1,
			chunk: "compiling...\n",
		});
		await client.call("stream/cancel", {
			run,
			path,
			reason: "budget exceeded",
		});

		const entries = await allEntries(run);
		const logEntry = entries.find((e) => e.path === path);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);
		const stderrEntry = entries.find((e) => e.path === `${path}_2`);

		assert.strictEqual(status(stdoutEntry), 499, "stdout → 499");
		assert.strictEqual(status(stderrEntry), 499, "stderr → 499");
		assert.strictEqual(
			stdoutEntry.body,
			"compiling...\n",
			"partial output preserved",
		);

		assert.ok(
			logEntry.body.startsWith("cancelled "),
			`log body notes cancel: ${logEntry.body}`,
		);
		assert.ok(
			logEntry.body.includes("budget exceeded"),
			`log body has reason: ${logEntry.body}`,
		);
	});

	it("stream/cancel works for stale 102 cleanup (no prior chunks)", async () => {
		const run = await startRun();
		const path = await seedShProposal(run, "stale_test", "hang");
		await accept(run, path);

		await client.call("stream/cancel", {
			run,
			path,
			reason: "stale cleanup",
		});

		const entries = await allEntries(run);
		const stdoutEntry = entries.find((e) => e.path === `${path}_1`);

		assert.strictEqual(status(stdoutEntry), 499);
		assert.strictEqual(stdoutEntry.body, "", "empty body preserved");
	});

	it("env scheme follows identical streaming pattern", async () => {
		const run = await startRun();
		const path = await seedProposal(run, "env://turn_1/pwd", {
			command: "pwd",
			summary: "pwd",
		});

		await accept(run, path);
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
		assert.strictEqual(status(stdoutEntry), 200);
		assert.strictEqual(stdoutEntry.body, "/tmp\n");
	});

	it("stream requires all params (run, path, channel, chunk)", async () => {
		const run = await startRun();

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
