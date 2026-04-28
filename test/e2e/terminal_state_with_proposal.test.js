import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_TEST_MODEL;
const TIMEOUT = 360_000;
const POLL_INTERVAL_MS = 500;

async function waitForRunStatus(db, alias, targetStatuses, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const row = await db.get_run_by_alias.get({ alias });
		if (row && targetStatuses.includes(row.status)) return row.status;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return null;
}

/**
 * Regression test for the proposal handshake: file writes go through
 * the proposal flow (202 awaiting resolve). If anything about the
 * proposal path disrupts the run/changed pulse cadence or the
 * derivable per-turn telemetry, this test catches it.
 */
describe("E2E: terminal status + pulse cadence after proposal acceptance (@notifications, @resolution, @plugins_rpc_queries)", {
	concurrency: 1,
}, () => {
	if (!model) {
		it.skip("RUMMY_TEST_MODEL not set — skipping", () => {});
		return;
	}

	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-proposal-handshake-${Date.now()}`);
	const prevMaxTurns = process.env.RUMMY_MAX_LOOP_TURNS;

	before(async () => {
		// 10 turns gives gemma room for Define→Discover→Deploy without
		// the cap forcing a confabulated 200 mid-investigation.
		process.env.RUMMY_MAX_LOOP_TURNS = "10";

		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(join(projectRoot, "seed.md"), "# Seed\n");
		// Plant a research target so gemma's Define→Discover→Deploy has
		// real material to walk through. Earlier the prompt was a trivial
		// direct-action ("Create FACTS.md with this exact sentence") that
		// fought the harness's research bias — gemma manufactured fluffy
		// unknowns (file system structure, formatting conventions) trying
		// to satisfy the protocol's imperative to register unknowns, and
		// never reached Deploy. A research-shaped prompt over a planted
		// data file is the workflow the harness was actually built for.
		await fs.writeFile(
			join(projectRoot, "data.txt"),
			"Pi is approximately 3.14159.\nThe speed of light is 299792458 m/s.\n",
		);
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);

		tdb = await TestDb.create("proposal-handshake");
		tserver = await TestServer.start(tdb);
		client = new RpcClient(tserver.url);
		await client.connect();

		await client.call("rummy/hello", {
			name: "proposal-handshake-test",
			projectRoot,
			clientVersion: "2.0.0",
		});

		// Run started below uses `yolo: true` — server-side auto-resolves
		// proposals, materializes file edits to disk. No client handler.
	}, TIMEOUT);

	after(async () => {
		client?.close();
		await tserver?.stop();
		await tdb?.cleanup();
		await fs.rm(projectRoot, { recursive: true, force: true });
		if (prevMaxTurns === undefined) delete process.env.RUMMY_MAX_LOOP_TURNS;
		else process.env.RUMMY_MAX_LOOP_TURNS = prevMaxTurns;
	});

	it("proposal flow + run/changed pulses; telemetry derivable from store", {
		timeout: TIMEOUT,
	}, async () => {
		const pulses = [];
		client.on("run/changed", (p) => pulses.push(p));

		const startRes = await client.call("set", {
			path: "run://",
			// The test's purpose is verifying the proposal-acceptance
			// machinery — at least one proposal must fire. Research-shaped
			// prompt over a planted data file flows through the protocol
			// naturally: Definition registers the unknown about the file's
			// contents, Discovery `<get>`s it, Deployment `<set>`s
			// FACTS.md — at least one proposal fires by construction.
			body: "Read data.txt in this project, then write FACTS.md as a markdown list of the facts it contains.",
			attributes: { model, mode: "act", yolo: true },
		});
		assert.ok(startRes?.alias, "expected alias");
		const alias = startRes.alias;
		console.log(`[TEST] started run: ${alias}`);

		const finalStatus = await waitForRunStatus(
			tdb.db,
			alias,
			[200, 413, 499, 500],
			300_000,
		);
		assert.ok(finalStatus, "run reached terminal status in DB");
		console.log(`[TEST] DB terminal status: ${finalStatus}`);

		await new Promise((r) => setTimeout(r, 1000));

		console.log(`[TEST] captured ${pulses.length} run/changed pulses`);
		assert.ok(pulses.length > 0, "received run/changed pulses for this run");
		for (const p of pulses) {
			assert.strictEqual(p.run, alias, "pulse scoped to this run");
		}

		// Proposal flow exercised: at least one resolved set:// log entry
		// exists (proposals are file edits, accepted by yolo).
		const runRow = await tdb.db.get_run_by_alias.get({ alias });
		const setLogEntries = await tdb.db.get_known_entries.all({
			run_id: runRow.id,
		});
		const resolvedSets = setLogEntries.filter(
			(e) =>
				e.scheme === "log" &&
				/^log:\/\/turn_\d+\/set\//.test(e.path) &&
				e.state === "resolved",
		);
		assert.ok(
			resolvedSets.length > 0,
			"proposal flow fired (at least one resolved set log entry)",
		);

		// Telemetry derivable from the turns table — same source the
		// statusline pulls from after the typed notification surface
		// goes away.
		const turns = await tdb.db.get_turns_by_run.all({ run_id: runRow.id });
		assert.ok(turns.length > 0, "turn rows exist");
		for (const t of turns) {
			if (!t.context_tokens) continue; // turn that didn't run an LLM call
			assert.ok(
				typeof t.context_tokens === "number" && t.context_tokens > 0,
				`turn ${t.sequence} context_tokens populated`,
			);
			assert.ok(
				typeof t.prompt_tokens === "number" && t.prompt_tokens >= 0,
				`turn ${t.sequence} prompt_tokens populated`,
			);
		}
	});
});
