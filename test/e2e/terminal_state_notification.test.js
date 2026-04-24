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

describe("E2E: terminal run/state notification (@notifications, @run_state_machine, @plugins_client_notifications, @plugins_rpc_notifications, @plugins_rpc_handshake)", {
	concurrency: 1,
}, () => {
	if (!model) {
		it.skip("RUMMY_TEST_MODEL not set — skipping", () => {});
		return;
	}

	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-handshake-${Date.now()}`);
	const prevMaxTurns = process.env.RUMMY_MAX_TURNS;

	before(async () => {
		process.env.RUMMY_MAX_TURNS = "3";

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

		// Auto-accept proposals (yolo)
		client.on("run/proposal", async ({ run, proposed }) => {
			for (const p of proposed || []) {
				try {
					await client.call("set", {
						run,
						path: p.path,
						state: "resolved",
					});
				} catch {
					/* ignore */
				}
			}
		});
	}, TIMEOUT);

	after(async () => {
		client?.close();
		await tserver?.stop();
		await tdb?.cleanup();
		await fs.rm(projectRoot, { recursive: true, force: true });
		if (prevMaxTurns === undefined) delete process.env.RUMMY_MAX_TURNS;
		else process.env.RUMMY_MAX_TURNS = prevMaxTurns;
	});

	it("last run/state notification carries terminal status (>= 200)", {
		timeout: TIMEOUT,
	}, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

		const startRes = await client.call("set", {
			path: "run://",
			body: 'What is 2 + 2? Answer with <update status="200">4</update>.',
			attributes: { model, mode: "ask" },
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

		// Give notifications a moment to catch up past the DB write.
		await new Promise((r) => setTimeout(r, 500));

		console.log(`[TEST] captured ${states.length} run/state notifications`);
		for (const s of states) {
			console.log(`  turn=${s.turn} status=${s.status}`);
		}

		assert.ok(states.length > 0, "received run/state notifications");
		const terminalState = states.findLast((s) => s.status >= 200);
		assert.ok(
			terminalState,
			`at least one run/state notification carries terminal status >= 200, got: ${states.map((s) => s.status).join(",")}`,
		);
		assert.strictEqual(
			terminalState.status,
			finalStatus,
			"terminal notification status matches DB terminal status",
		);

		// Terminal emit must carry current turn's telemetry so the client's
		// statusline doesn't display the previous turn's context_tokens.
		const tel = terminalState.telemetry;
		assert.ok(tel, "terminal notification carries telemetry");
		assert.ok(
			typeof tel.context_tokens === "number" && tel.context_tokens > 0,
			`telemetry.context_tokens populated, got ${JSON.stringify(tel)}`,
		);

		// Budget fields drive the statusline — same numbers the model
		// sees on the <prompt> tag.
		assert.ok(
			typeof tel.ceiling === "number" && tel.ceiling > 0,
			`telemetry.ceiling populated, got ${tel.ceiling}`,
		);
		assert.ok(
			typeof tel.token_usage === "number",
			`telemetry.token_usage populated, got ${tel.token_usage}`,
		);
		assert.ok(
			typeof tel.tokens_free === "number" && tel.tokens_free >= 0,
			`telemetry.tokens_free populated, got ${tel.tokens_free}`,
		);
	});
});
