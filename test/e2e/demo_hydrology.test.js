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

describe("E2E: hydrology demo scenario reproduction", { concurrency: 1 }, () => {
	if (!model) { it.skip("skip", () => {}); return; }
	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-hydro-${Date.now()}`);
	const prevMaxTurns = process.env.RUMMY_MAX_TURNS;

	before(async () => {
		process.env.RUMMY_MAX_TURNS = "8";
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(join(projectRoot, "seed.md"), "# Seed\n");
		const { execSync } = await import("node:child_process");
		execSync('git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"', { cwd: projectRoot });
		tdb = await TestDb.create("hydro");
		tserver = await TestServer.start(tdb);
		client = new RpcClient(tserver.url);
		await client.connect();
		await client.call("rummy/hello", { name: "hydro-test", projectRoot, clientVersion: "2.0.0" });
		client.on("run/proposal", async ({ run, proposed }) => {
			for (const p of proposed || []) {
				try {
					if (p.path?.startsWith("set://")) {
						const runRow = await tdb.db.get_run_by_alias.get({ alias: run });
						const entries = await tdb.db.get_known_entries.all({ run_id: runRow.id });
						const setEntry = entries.find((e) => e.path === p.path);
						if (setEntry) {
							const attrs = typeof setEntry.attributes === "string" ? JSON.parse(setEntry.attributes) : setEntry.attributes;
							if (attrs?.path && attrs?.merge) {
								const filePath = join(projectRoot, attrs.path);
								const content = await fs.readFile(filePath, "utf8").catch(() => "");
								const blocks = attrs.merge.split(/(?=<<<<<<< SEARCH)/);
								let patched = content;
								for (const b of blocks) {
									const m = b.match(/<<<<<<< SEARCH\n?([\s\S]*?)\n?=======\n?([\s\S]*?)\n?>>>>>>> REPLACE/);
									if (!m) continue;
									patched = m[1] === "" ? m[2] : patched.replace(m[1], m[2]);
								}
								if (patched !== content) await fs.writeFile(filePath, patched);
							}
						}
					}
					await client.call("set", { run, path: p.path, state: "resolved" });
				} catch (err) {
					console.error(`[TEST] auto-accept error: ${err.message}`);
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

	it("demo scenario: terminal run/state fires after proposal-heavy multi-turn flow", { timeout: TIMEOUT }, async () => {
		const states = [];
		const proposals = [];
		client.on("run/state", (p) => states.push(p));
		client.on("run/proposal", (p) => proposals.push(p));

		const startRes = await client.call("set", {
			path: "run://",
			body: "Deliver a comprehensive review of the hydrology of Orange County, Indiana in OC_RIVERS.md.",
			attributes: { model, mode: "act" },
		});
		const alias = startRes.alias;
		console.log(`[TEST] started run: ${alias}`);

		const finalStatus = await waitForRunStatus(tdb.db, alias, [200, 413, 499, 500], 300_000);
		assert.ok(finalStatus, "DB reached terminal status");
		await new Promise((r) => setTimeout(r, 1000));

		console.log(`[TEST] finalStatus=${finalStatus}  proposals=${proposals.length}  states=${states.length}`);
		for (const s of states) {
			console.log(`  turn=${s.turn} status=${s.status} ceiling=${s.telemetry?.ceiling} free=${s.telemetry?.tokens_free} used=${s.telemetry?.token_usage}`);
		}

		assert.ok(proposals.length > 0, "scenario must exercise proposals");
		const terminal = states.findLast((s) => s.status >= 200);
		assert.ok(terminal, "terminal run/state arrived");
		assert.strictEqual(terminal.status, finalStatus);
		for (const s of states) {
			assert.ok(s.telemetry?.ceiling > 0, `turn ${s.turn} ceiling`);
			assert.ok(typeof s.telemetry?.token_usage === "number", `turn ${s.turn} token_usage`);
			assert.ok(s.telemetry?.tokens_free >= 0, `turn ${s.turn} tokens_free`);
		}
	});
});
