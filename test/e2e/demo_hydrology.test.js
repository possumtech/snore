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

describe("E2E: hydrology demo scenario reproduction (@notifications, @run_state_machine)", {
	concurrency: 1,
}, () => {
	if (!model) {
		it.skip("skip", () => {});
		return;
	}
	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-hydro-${Date.now()}`);
	const prevMaxTurns = process.env.RUMMY_MAX_TURNS;

	before(async () => {
		// 16 turns gives gemma room for Define→Discover→Deploy across a
		// real research scenario. Earlier 8 was too tight: gemma 200'd
		// at iter 5 with a confabulated "FACTS.md created" (wrong file
		// name) before reaching the actual write phase.
		process.env.RUMMY_MAX_TURNS = "16";
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(join(projectRoot, "seed.md"), "# Seed\n");
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);
		tdb = await TestDb.create("hydro");
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
		if (prevMaxTurns === undefined) delete process.env.RUMMY_MAX_TURNS;
		else process.env.RUMMY_MAX_TURNS = prevMaxTurns;
	});

	it("demo scenario: terminal run/state fires after multi-turn flow with deliverable on disk", {
		timeout: TIMEOUT,
	}, async () => {
		const states = [];
		client.on("run/state", (p) => states.push(p));

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

		console.log(
			`[TEST] finalStatus=${finalStatus}  states=${states.length}`,
		);
		for (const s of states) {
			console.log(
				`  turn=${s.turn} status=${s.status} ceiling=${s.telemetry?.ceiling} free=${s.telemetry?.tokens_free} used=${s.telemetry?.token_usage}`,
			);
		}

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

		const terminal = states.findLast((s) => s.status >= 200);
		assert.ok(terminal, "terminal run/state arrived");
		assert.strictEqual(terminal.status, finalStatus);
		for (const s of states) {
			assert.ok(s.telemetry?.ceiling > 0, `turn ${s.turn} ceiling`);
			assert.ok(
				typeof s.telemetry?.token_usage === "number",
				`turn ${s.turn} token_usage`,
			);
			assert.ok(s.telemetry?.tokens_free >= 0, `turn ${s.turn} tokens_free`);
		}
	});
});
