/**
 * YOLO mode — auto-accept proposals + server-side sh/env execution.
 *
 * Covers @yolo_mode — the plugin that emulates a connected headless
 * client when a run is started with `yolo: true`. Drives the
 * `proposal.pending` event with a yolo-flagged rummy context and
 * asserts the side effects landed: file edits materialize, sh
 * commands actually spawn and stream output, channel entries
 * transition to terminal state.
 */
import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import { logPathToDataBase } from "../../src/plugins/helpers.js";
import TestDb from "../helpers/TestDb.js";

async function makeRummy(tdb, runId, projectId, projectRoot, yolo, signal) {
	const entries = new Entries(tdb.db);
	entries.loadSchemes(tdb.db);
	return {
		runId,
		projectId,
		entries,
		db: tdb.db,
		yolo: yolo === true,
		hooks: tdb.hooks,
		project: { id: projectId, project_root: projectRoot },
		signal,
	};
}

// Wait for both streaming data channels to reach a terminal state.
// finalizeStream transitions {dataBase}_1 and _2 out of "streaming"
// when the child closes; awaiting both prevents trailing writes from
// racing with TestDb cleanup at suite teardown.
async function waitForChannelsTerminal(entries, runId, dataBase) {
	await Promise.all([
		entries.waitForResolution(runId, `${dataBase}_1`),
		entries.waitForResolution(runId, `${dataBase}_2`),
	]);
}

async function seedSetProposal(entries, runId, turn, relPath, content) {
	const slug = encodeURIComponent(relPath);
	const proposalPath = `log://turn_${turn}/set/${slug}`;
	await entries.set({
		runId,
		turn,
		path: proposalPath,
		body: content,
		state: "proposed",
		attributes: {
			path: relPath,
			merge: `<<<<<<< SEARCH\n=======\n${content}\n>>>>>>> REPLACE`,
		},
	});
	return proposalPath;
}

async function seedShProposal(entries, runId, turn, command) {
	const slug = encodeURIComponent(command);
	const proposalPath = `log://turn_${turn}/sh/${slug}`;
	await entries.set({
		runId,
		turn,
		path: proposalPath,
		body: "",
		state: "proposed",
		attributes: { command, summary: command },
	});
	return proposalPath;
}

describe("yolo mode (@yolo_mode)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("yolo_mode");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("set proposal auto-accepts and materializes the file on yolo run", async () => {
		const projectRoot = join(tmpdir(), `yolo_set_${Date.now()}`);
		await fs.mkdir(projectRoot, { recursive: true });
		const { runId, projectId } = await tdb.seedRun({
			alias: "yolo_set",
			projectRoot,
		});
		const rummy = await makeRummy(tdb, runId, projectId, projectRoot, true);

		const content = "# materialized via yolo\n";
		const proposalPath = await seedSetProposal(
			rummy.entries,
			runId,
			1,
			"out.md",
			content,
		);

		const proposed = [{ path: proposalPath }];
		await tdb.hooks.proposal.pending.emit({
			projectId,
			run: "yolo_set",
			proposed,
			rummy,
		});

		const proposalState = await rummy.entries.getState(runId, proposalPath);
		assert.strictEqual(
			proposalState.state,
			"resolved",
			"proposal flipped to resolved by yolo plugin",
		);

		const fileBody = await rummy.entries.getBody(runId, "out.md");
		assert.strictEqual(
			fileBody,
			content,
			"bare-path file entry materialized with proposed content",
		);

		const onDisk = await fs
			.readFile(join(projectRoot, "out.md"), "utf8")
			.catch(() => null);
		assert.strictEqual(onDisk, content, "file written to disk by set plugin");
	});

	it("non-yolo run leaves proposal alone (regression guard)", async () => {
		const projectRoot = join(tmpdir(), `yolo_nonyolo_${Date.now()}`);
		await fs.mkdir(projectRoot, { recursive: true });
		const { runId, projectId } = await tdb.seedRun({
			alias: "yolo_nonyolo",
			projectRoot,
		});
		const rummy = await makeRummy(tdb, runId, projectId, projectRoot, false);

		const proposalPath = await seedSetProposal(
			rummy.entries,
			runId,
			1,
			"untouched.md",
			"should not land",
		);

		await tdb.hooks.proposal.pending.emit({
			projectId,
			run: "yolo_nonyolo",
			proposed: [{ path: proposalPath }],
			rummy,
		});

		const proposalState = await rummy.entries.getState(runId, proposalPath);
		assert.strictEqual(
			proposalState.state,
			"proposed",
			"non-yolo run leaves proposal in proposed state",
		);
		const fileBody = await rummy.entries.getBody(runId, "untouched.md");
		assert.strictEqual(fileBody, null, "no file materialized for non-yolo run");
	});

	it("sh proposal spawns command server-side and streams output", async () => {
		const projectRoot = join(tmpdir(), `yolo_sh_${Date.now()}`);
		await fs.mkdir(projectRoot, { recursive: true });
		const { runId, projectId } = await tdb.seedRun({
			alias: "yolo_sh",
			projectRoot,
		});
		const rummy = await makeRummy(tdb, runId, projectId, projectRoot, true);

		const proposalPath = await seedShProposal(
			rummy.entries,
			runId,
			1,
			'echo "hello yolo"',
		);

		await tdb.hooks.proposal.pending.emit({
			projectId,
			run: "yolo_sh",
			proposed: [{ path: proposalPath }],
			rummy,
		});
		const dataBase = logPathToDataBase(proposalPath);
		const stdoutPath = `${dataBase}_1`;
		await waitForChannelsTerminal(rummy.entries, runId, dataBase);

		const stdoutBody = await rummy.entries.getBody(runId, stdoutPath);
		assert.ok(
			stdoutBody?.includes("hello yolo"),
			`stdout streamed to ${stdoutPath}; got: ${JSON.stringify(stdoutBody)}`,
		);

		const stdoutState = await rummy.entries.getState(runId, stdoutPath);
		assert.strictEqual(
			stdoutState?.state,
			"resolved",
			"stdout channel transitioned to terminal resolved state on exit 0",
		);

		const proposalState = await rummy.entries.getState(runId, proposalPath);
		assert.strictEqual(
			proposalState.state,
			"resolved",
			"sh log entry resolved after command + auto-accept",
		);
	});

	it("abort during long-running sh kills the child and resolves promptly", async () => {
		// Regression for the pypi-server tbench pathology: when rummy-cli's
		// 895s watchdog → projectAgent.shutdown → AgentLoop.abortAll fires
		// while a long <sh> is mid-flight, the spawned child must die so
		// drain unwinds before harbor's outer SIGKILL hits and trashes the
		// post-mortem packet (rummy.db / turns/ / last_run.txt).
		const projectRoot = join(tmpdir(), `yolo_sh_abort_${Date.now()}`);
		await fs.mkdir(projectRoot, { recursive: true });
		const { runId, projectId } = await tdb.seedRun({
			alias: "yolo_sh_abort",
			projectRoot,
		});
		const controller = new AbortController();
		const rummy = await makeRummy(
			tdb,
			runId,
			projectId,
			projectRoot,
			true,
			controller.signal,
		);

		// 30s sleep — would deadline-blow the test if abort weren't honored.
		const proposalPath = await seedShProposal(
			rummy.entries,
			runId,
			1,
			"sleep 30",
		);

		const start = Date.now();
		const pending = tdb.hooks.proposal.pending.emit({
			projectId,
			run: "yolo_sh_abort",
			proposed: [{ path: proposalPath }],
			rummy,
		});

		// Give spawn a moment to launch, then abort.
		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort();
		await pending;
		const dataBase = logPathToDataBase(proposalPath);
		await waitForChannelsTerminal(rummy.entries, runId, dataBase);
		const elapsed = Date.now() - start;
		assert.ok(
			elapsed < 5000,
			`abort unwound in ${elapsed}ms — must be well under sleep 30 (5s ceiling)`,
		);

		const stdoutState = await rummy.entries.getState(runId, `${dataBase}_1`);
		// On SIGTERM-from-abort the child exits non-zero; channels land
		// in a terminal state either way, never lingering in 'streaming'.
		assert.ok(
			stdoutState?.state === "resolved" || stdoutState?.state === "failed",
			`channel transitioned to terminal state; got ${stdoutState?.state}`,
		);
	});

	it("sh nonzero exit transitions channels to failed", async () => {
		const projectRoot = join(tmpdir(), `yolo_sh_fail_${Date.now()}`);
		await fs.mkdir(projectRoot, { recursive: true });
		const { runId, projectId } = await tdb.seedRun({
			alias: "yolo_sh_fail",
			projectRoot,
		});
		const rummy = await makeRummy(tdb, runId, projectId, projectRoot, true);

		const proposalPath = await seedShProposal(
			rummy.entries,
			runId,
			1,
			'echo "to stderr" 1>&2; exit 7',
		);

		await tdb.hooks.proposal.pending.emit({
			projectId,
			run: "yolo_sh_fail",
			proposed: [{ path: proposalPath }],
			rummy,
		});
		const dataBase = logPathToDataBase(proposalPath);
		const stderrPath = `${dataBase}_2`;
		await waitForChannelsTerminal(rummy.entries, runId, dataBase);

		const stderrBody = await rummy.entries.getBody(runId, stderrPath);
		assert.ok(
			stderrBody?.includes("to stderr"),
			`stderr captured at ${stderrPath}; got: ${JSON.stringify(stderrBody)}`,
		);

		const stderrState = await rummy.entries.getState(runId, stderrPath);
		assert.strictEqual(
			stderrState?.state,
			"failed",
			"stderr channel transitioned to failed on nonzero exit",
		);
	});
});
