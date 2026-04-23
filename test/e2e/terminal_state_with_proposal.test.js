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
 * Regression test for the handshake bug: file writes go through the
 * proposal flow (202 awaiting resolve). If anything about the proposal
 * path disrupts the terminal run/state emission, this test catches it.
 */
describe("E2E: terminal run/state after proposal acceptance (@notifications, @resolution)", {
	concurrency: 1,
}, () => {
	if (!model) {
		it.skip("RUMMY_TEST_MODEL not set — skipping", () => {});
		return;
	}

	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-proposal-handshake-${Date.now()}`);
	const prevMaxTurns = process.env.RUMMY_MAX_TURNS;

	before(async () => {
		process.env.RUMMY_MAX_TURNS = "5";

		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(join(projectRoot, "seed.md"), "# Seed\n");
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

		// Auto-accept: apply file writes to disk before resolving,
		// matching what the nvim yolo client does in diff.apply_to_file.
		client.on("run/proposal", async ({ run, proposed }) => {
			for (const p of proposed || []) {
				try {
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

	it("after proposal accept, terminal run/state (status >= 200) arrives", {
		timeout: TIMEOUT,
	}, async () => {
		const states = [];
		const proposals = [];
		client.on("run/state", (p) => states.push(p));
		client.on("run/proposal", (p) => proposals.push(p));

		const startRes = await client.call("set", {
			path: "run://",
			body: "Research the number 42 briefly via search, then create FACTS.md with one interesting fact. Search first, then write.",
			attributes: { model, mode: "act" },
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

		// Give notifications a moment to catch up past the DB write.
		await new Promise((r) => setTimeout(r, 1000));

		console.log(
			`[TEST] captured ${states.length} run/state, ${proposals.length} run/proposal`,
		);
		for (const s of states) {
			console.log(
				`  state turn=${s.turn} status=${s.status} ceiling=${s.telemetry?.ceiling} free=${s.telemetry?.tokens_free}`,
			);
		}

		assert.ok(
			proposals.length > 0,
			"test must exercise proposal flow (no proposals fired)",
		);

		const terminalState = states.findLast((s) => s.status >= 200);
		assert.ok(
			terminalState,
			`at least one run/state carries terminal status; got: ${states.map((s) => s.status).join(",")}`,
		);
		assert.strictEqual(
			terminalState.status,
			finalStatus,
			"terminal notification status matches DB terminal status",
		);

		// EVERY run/state this run emits must carry complete budget
		// telemetry so the statusline can't fall back to stale values.
		for (const s of states) {
			const t = s.telemetry;
			assert.ok(t, `run/state[turn=${s.turn}] has telemetry`);
			assert.ok(
				typeof t.ceiling === "number" && t.ceiling > 0,
				`run/state[turn=${s.turn}] telemetry.ceiling populated, got ${t.ceiling}`,
			);
			assert.ok(
				typeof t.token_usage === "number",
				`run/state[turn=${s.turn}] telemetry.token_usage populated, got ${t.token_usage}`,
			);
			assert.ok(
				typeof t.tokens_free === "number" && t.tokens_free >= 0,
				`run/state[turn=${s.turn}] telemetry.tokens_free populated, got ${t.tokens_free}`,
			);
			// Soft invariant: tokens_free can never exceed ceiling,
			// and token_usage should fit within ceiling too.
			assert.ok(
				t.tokens_free <= t.ceiling,
				`tokens_free (${t.tokens_free}) must not exceed ceiling (${t.ceiling})`,
			);
			assert.ok(
				t.token_usage <= t.ceiling,
				`token_usage (${t.token_usage}) must not exceed ceiling (${t.ceiling})`,
			);
		}

		// Exactly one run/state per turn (one-per-turn emit from
		// AgentLoop). Multiple emits per turn would indicate we
		// reintroduced the hardcoded-102 per-command emits that
		// caused the proposal-checkmark race.
		const byTurn = new Map();
		for (const s of states) {
			byTurn.set(s.turn, (byTurn.get(s.turn) ?? 0) + 1);
		}
		for (const [turn, count] of byTurn) {
			assert.strictEqual(
				count,
				1,
				`turn ${turn} emitted ${count} run/state events; expected exactly 1`,
			);
		}

		// Exactly one terminal state in the whole stream.
		const terminals = states.filter((s) => s.status >= 200);
		assert.strictEqual(
			terminals.length,
			1,
			`expected exactly 1 terminal run/state, got ${terminals.length}`,
		);
	});
});
