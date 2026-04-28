import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

describe("E2E: hydrology demo scenario reproduction (@notifications, @run_state_machine)", {
	concurrency: 1,
}, () => {
	if (!model) {
		it.skip("skip", () => {});
		return;
	}
	let tdb, tserver, client;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const projectRoot = join(tmpdir(), `rummy-hydro-${Date.now()}`);
	const turnsHome = join(__dirname, "turns", `hydro_${stamp}`);

	before(async () => {
		// Use the default RUMMY_MAX_TURNS (99). Capping low short-circuits
		// the guardrail-bouncing the state machine is designed for: weak
		// models succeed by repeatedly hitting the protocol's edges until
		// they converge.
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.mkdir(turnsHome, { recursive: true });
		await fs.writeFile(join(projectRoot, "seed.md"), "# Seed\n");
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);
		tdb = await TestDb.create("hydro", { home: turnsHome });
		tserver = await TestServer.start(tdb);
		client = new RpcClient(tserver.url);
		await client.connect();
		await client.call("rummy/hello", {
			name: "hydro-test",
			projectRoot,
			clientVersion: "2.0.0",
		});
		// Run started below uses `yolo: true` — server-side auto-resolves
		// proposals and materializes file edits. No client-side handler.
	}, TIMEOUT);

	after(async () => {
		client?.close();
		await tserver?.stop();
		await tdb?.cleanup();
		await fs.rm(projectRoot, { recursive: true, force: true });
	});

	it("demo scenario: run reaches terminal status with deliverable on disk + per-turn telemetry derivable from store", {
		timeout: TIMEOUT,
	}, async () => {
		const pulses = [];
		client.on("run/changed", (p) => pulses.push(p));

		const startRes = await client.call("set", {
			path: "run://",
			body: "Write a brief OC_RIVERS.md about the hydrology of Orange County, Indiana. Three sections minimum: rivers, watersheds, and one other relevant aspect you investigate. Keep each section short.",
			attributes: { model, mode: "act", yolo: true },
		});
		const alias = startRes.alias;
		console.log(`[TEST] started run: ${alias}`);

		const finalStatus = await waitForRunStatus(
			tdb.db,
			alias,
			[200, 413, 499, 500],
			300_000,
		);
		assert.ok(finalStatus, "DB reached terminal status");
		await new Promise((r) => setTimeout(r, 1000));

		console.log(`[TEST] finalStatus=${finalStatus}  pulses=${pulses.length}`);

		// Outcome-based: the deliverable must exist on disk with
		// substantive content. Whichever wire-protocol path the model
		// chose is its own business — the test cares that the user's
		// intent ("write OC_RIVERS.md") was carried out.
		const deliverable = await fs
			.readFile(join(projectRoot, "OC_RIVERS.md"), "utf8")
			.catch(() => null);
		assert.ok(deliverable, "OC_RIVERS.md exists on disk");
		assert.ok(
			deliverable.length > 200,
			`OC_RIVERS.md has substantive content (got ${deliverable?.length ?? 0} chars)`,
		);

		// Pulses fired during the run; client could reconcile via getEntries.
		assert.ok(pulses.length > 0, "received run/changed pulses for this run");
		for (const p of pulses) assert.strictEqual(p.run, alias);

		// Per-turn telemetry derivable from turns table — same source the
		// statusline pulls from after typed notifications go away.
		const runRow = await tdb.db.get_run_by_alias.get({ alias });
		const turns = await tdb.db.get_turns_by_run.all({ run_id: runRow.id });
		assert.ok(turns.length > 0, "turn rows exist");
		for (const t of turns) {
			if (!t.context_tokens) continue;
			assert.ok(
				typeof t.context_tokens === "number" && t.context_tokens > 0,
				`turn ${t.sequence} context_tokens populated`,
			);
		}
	});
});
