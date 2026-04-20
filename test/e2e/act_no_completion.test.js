import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_TEST_MODEL;
const TIMEOUT = 360_000;
const POLL_INTERVAL_MS = 500;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function waitForRunStatus(db, alias, targetStatuses, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const row = await db.get_run_by_alias.get({ alias });
		if (row && targetStatuses.includes(row.status)) return row.status;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return null;
}

async function dumpRun(db, alias) {
	const runRow = await db.get_run_by_alias.get({ alias });
	if (!runRow) {
		console.log(`[DUMP] run not found: ${alias}`);
		return;
	}
	const entries = await db.get_known_entries.all({ run_id: runRow.id });
	console.log(
		`\n[DUMP] run=${alias} id=${runRow.id} status=${runRow.status} next_turn=${runRow.next_turn}`,
	);
	const byTurn = new Map();
	for (const e of entries) {
		if (!byTurn.has(e.turn)) byTurn.set(e.turn, []);
		byTurn.get(e.turn).push(e);
	}
	for (const t of [...byTurn.keys()].toSorted((a, b) => a - b)) {
		console.log(`\n[DUMP] turn ${t}:`);
		for (const e of byTurn.get(t)) {
			console.log(`  ${e.scheme || "file"}:${e.state}/${e.fidelity} ${e.path}`);
		}
	}
}

describe("E2E: run completion after set-only final turn", {
	concurrency: 1,
}, () => {
	if (!model) {
		it.skip("RUMMY_TEST_MODEL not set — skipping", () => {});
		return;
	}

	let tdb, tserver, client;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const projectRoot = join(tmpdir(), `rummy-complete-${Date.now()}`);
	const turnsHome = join(__dirname, "turns", `complete_${stamp}`);
	const prevMaxTurns = process.env.RUMMY_MAX_TURNS;

	before(async () => {
		// Cap iterations so the test bounds runtime regardless of model
		// willingness to emit a terminal update.
		process.env.RUMMY_MAX_TURNS = "5";

		await fs.mkdir(projectRoot, { recursive: true });
		await fs.mkdir(turnsHome, { recursive: true });
		await fs.writeFile(
			join(projectRoot, "seed.md"),
			"# Seed file\nThis file exists so the project has at least one entry.\n",
		);
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);

		tdb = await TestDb.create("complete");
		tserver = await TestServer.start(tdb, { home: turnsHome });
		client = new RpcClient(tserver.url);
		await client.connect();

		await client.call("rummy/hello", {
			name: "complete-test",
			projectRoot,
			clientVersion: "2.0.0",
		});

		// Auto-accept every proposal via the 2.0.0 wire: set state=resolved.
		// This is what a yolo nvim client does.
		client.on("run/proposal", async ({ run, proposed }) => {
			for (const p of proposed || []) {
				try {
					// Apply file writes to disk before accepting — matches what
					// the nvim client does in diff.apply_to_file + yolo path.
					if (p.path?.startsWith("set://")) {
						const runRow = await tdb.db.get_run_by_alias.get({ alias: run });
						const entries = await tdb.db.get_known_entries.all({
							run_id: runRow.id,
						});
						const setEntry = entries.find((e) => e.path === p.path);
						if (setEntry) {
							const attrs =
								typeof setEntry.attributes === "string"
									? JSON.parse(setEntry.attributes)
									: setEntry.attributes;
							if (attrs?.path && attrs?.merge) {
								const filePath = join(projectRoot, attrs.path);
								const content = await fs
									.readFile(filePath, "utf8")
									.catch(() => "");
								const blocks = attrs.merge.split(/(?=<<<<<<< SEARCH)/);
								let patched = content;
								for (const b of blocks) {
									const m = b.match(
										/<<<<<<< SEARCH\n?([\s\S]*?)\n?=======\n?([\s\S]*?)\n?>>>>>>> REPLACE/,
									);
									if (!m) continue;
									patched = m[1] === "" ? m[2] : patched.replace(m[1], m[2]);
								}
								if (patched !== content) await fs.writeFile(filePath, patched);
							}
						}
					}
					await client.call("set", {
						run,
						path: p.path,
						state: "resolved",
					});
				} catch (err) {
					console.error(
						`[TEST] auto-accept error on ${p.path}: ${err.message}`,
					);
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

	it("act run producing a file edit reaches completion", {
		timeout: TIMEOUT,
	}, async () => {
		// Trigger the pattern the user reports: act mode, prompt that will
		// cause the model to search/research then produce a single file edit.
		const startRes = await client.call("set", {
			path: "run://",
			body: "Create a file called FACTS.md with one interesting fact about the number 42. One short sentence.",
			attributes: { model, mode: "act" },
		});

		assert.ok(startRes?.alias, "expected { alias } from anonymous set run://");
		const alias = startRes.alias;
		console.log(`[TEST] started run: ${alias}`);

		// Terminal statuses: 200 success, 499 cancelled, 500 failed, 413 overflow.
		const finalStatus = await waitForRunStatus(
			tdb.db,
			alias,
			[200, 413, 499, 500],
			300_000,
		);

		if (finalStatus === null) {
			console.error(
				`[TEST] run ${alias} did NOT reach terminal status in 150s`,
			);
			await dumpRun(tdb.db, alias);
			assert.fail(`run hung — last status was not terminal`);
		}

		// The engine's job is to reach a terminal state within budget.
		// 200: model signalled <update status="200|204|422">.
		// 499: three strikes (contract violation or repetition).
		// Either is a legitimate engine outcome. What we proved by
		// reaching here: the run isn't stuck on waitForResolution.
		console.log(`[TEST] run ${alias} terminal status: ${finalStatus}`);
		await dumpRun(tdb.db, alias);
		assert.ok(
			[200, 499].includes(finalStatus),
			`expected 200 or 499, got ${finalStatus}`,
		);

		const entries = await tdb.db.get_known_entries.all({
			run_id: (await tdb.db.get_run_by_alias.get({ alias })).id,
		});
		const setEntry = entries.find(
			(e) => e.scheme === "set" && e.state === "resolved",
		);
		assert.ok(setEntry, "expected at least one resolved set entry");
	});
});
