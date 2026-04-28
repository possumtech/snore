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

describe("E2E: run/changed pulse + query reaches terminal (@notifications, @run_state_machine, @plugins_client_notifications, @plugins_rpc_notifications, @plugins_rpc_handshake)", {
	concurrency: 1,
}, () => {
	if (!model) {
		it.skip("RUMMY_TEST_MODEL not set — skipping", () => {});
		return;
	}

	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-handshake-${Date.now()}`);
	const prevMaxTurns = process.env.RUMMY_MAX_LOOP_TURNS;

	before(async () => {
		process.env.RUMMY_MAX_LOOP_TURNS = "3";

		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(join(projectRoot, "seed.md"), "# Seed\n");
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);

		tdb = await TestDb.create("handshake");
		tserver = await TestServer.start(tdb);
		client = new RpcClient(tserver.url);
		await client.connect();

		await client.call("rummy/hello", {
			name: "handshake-test",
			projectRoot,
			clientVersion: "2.0.0",
		});

		// Run started below uses `yolo: true` for server-side auto-accept.
	}, TIMEOUT);

	after(async () => {
		client?.close();
		await tserver?.stop();
		await tdb?.cleanup();
		await fs.rm(projectRoot, { recursive: true, force: true });
		if (prevMaxTurns === undefined) delete process.env.RUMMY_MAX_LOOP_TURNS;
		else process.env.RUMMY_MAX_LOOP_TURNS = prevMaxTurns;
	});

	it("client receives run/changed pulses; reconciles terminal status + telemetry from store", {
		timeout: TIMEOUT,
	}, async () => {
		const pulses = [];
		client.on("run/changed", (p) => pulses.push(p));

		const startRes = await client.call("set", {
			path: "run://",
			body: 'What is 2 + 2? Answer with <update status="200">4</update>.',
			attributes: { model, mode: "ask", yolo: true },
		});

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

		// Give pulses a moment to flush past the final entry write.
		await new Promise((r) => setTimeout(r, 500));

		console.log(`[TEST] captured ${pulses.length} run/changed pulses`);
		assert.ok(
			pulses.length > 0,
			"received run/changed pulses (one per entry write in this run)",
		);
		for (const p of pulses) {
			assert.strictEqual(
				p.run,
				alias,
				"pulse carries the run alias the client cares about",
			);
		}

		// Telemetry lives in the turns table. The client's statusline
		// pulls the same fields by querying — same source as the model's
		// <budget> block sees.
		const runRow = await tdb.db.get_run_by_alias.get({ alias });
		const turns = await tdb.db.get_turns_by_run.all({ run_id: runRow.id });
		assert.ok(turns.length > 0, "turn rows exist for this run");
		const last = turns[turns.length - 1];
		assert.ok(
			typeof last.context_tokens === "number" && last.context_tokens > 0,
			`last turn's context_tokens populated, got ${last.context_tokens}`,
		);
		assert.ok(
			typeof last.prompt_tokens === "number" && last.prompt_tokens > 0,
			`last turn's prompt_tokens populated, got ${last.prompt_tokens}`,
		);
	});
});
