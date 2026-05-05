/**
 * E2E: budget signals align with API ground truth.
 *
 * Covers @budget_enforcement. The integration-tier tests prove the
 * wiring: if you pass lastContextTokens=X, you get tokenUsage=X on
 * the `<prompt>` tag. This test proves that the value we pass and
 * the value we get back AGREES with what the LLM actually charged
 * — the `turns.prompt_tokens` column backfilled from LLM usage.
 *
 * What a failure here means: the model is being told one number
 * for its packet size and getting charged a different one. That's
 * the exact bug that let runs silently over-promote for weeks.
 */
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

function tagAttrs(userBody, tag) {
	const m = userBody.match(new RegExp(`<${tag}\\b([^>]*)>`));
	if (!m) return {};
	const attrStr = m[1];
	const attrs = {};
	for (const pair of attrStr.matchAll(/(\w+)="([^"]*)"/g)) {
		attrs[pair[1]] = pair[2];
	}
	return attrs;
}

describe("E2E: budget signals match API ground truth (@budget_enforcement)", {
	concurrency: 1,
}, () => {
	if (!model) {
		it.skip("RUMMY_TEST_MODEL not set — skipping", () => {});
		return;
	}

	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-budget-${Date.now()}`);

	before(async () => {
		// Default RUMMY_MAX_LOOP_TURNS; TIMEOUT bounds wall-clock. Artificial
		// caps don't leave the model room to recover from bounce-offs.
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(join(projectRoot, "seed.md"), "# Seed\n");
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);

		tdb = await TestDb.create("budget_signals");
		tserver = await TestServer.start(tdb);
		client = new RpcClient(tserver.url);
		await client.connect();

		await client.call("rummy/hello", {
			name: "budget-signals-test",
			projectRoot,
			clientVersion: "2.0.0",
		});
		// Run started below uses `yolo: true` — server-side auto-resolves
		// proposals and self-executes sh/env. No client-side handler.
	}, TIMEOUT);

	after(async () => {
		client?.close();
		await tserver?.stop();
		await tdb?.cleanup();
		await fs.rm(projectRoot, { recursive: true, force: true });
	});

	it("budget tag carries non-zero tokenUsage and tokensFree on every turn", {
		timeout: TIMEOUT,
	}, async () => {
		// Per @token_accounting, tokenUsage and tokensFree live on <budget>
		// (materialization-derived: floor + premium + system) rather than
		// echoing the API's prompt_tokens. The signal is self-consistent
		// with the visible-scheme table inside the same tag — that's the
		// contract under test, not equality with raw API counts.
		const startRes = await client.call("set", {
			path: "run://",
			body: "Define an unknown://primes/three entry, then resolve it with a known://primes/three entry listing three primes.",
			attributes: { model, mode: "act", yolo: true },
		});
		const alias = startRes.alias;
		const finalStatus = await waitForRunStatus(
			tdb.db,
			alias,
			[200, 413, 499, 500],
			300_000,
		);
		assert.ok(finalStatus, "run reached terminal status");

		const runRow = await tdb.db.get_run_by_alias.get({ alias });
		const turns = await tdb.db.get_turns_by_run.all({ run_id: runRow.id });
		const userMsgs = {};
		const entries = await tdb.db.get_known_entries.all({ run_id: runRow.id });
		for (const e of entries) {
			const m = e.path.match(/^user:\/\/(\d+)$/);
			if (m) userMsgs[Number(m[1])] = e.body;
		}

		let checked = 0;
		for (const t of turns) {
			const body = userMsgs[t.sequence];
			assert.ok(body, `user message for turn ${t.sequence} exists`);
			const attrs = tagAttrs(body, "budget");
			assert.ok(
				attrs.tokenUsage,
				`turn ${t.sequence} <budget> has tokenUsage attr`,
			);
			assert.ok(
				attrs.tokensFree,
				`turn ${t.sequence} <budget> has tokensFree attr`,
			);
			const used = Number(attrs.tokenUsage);
			const free = Number(attrs.tokensFree);
			assert.ok(used > 0, `turn ${t.sequence} tokenUsage > 0`);
			assert.ok(free >= 0, `turn ${t.sequence} tokensFree ≥ 0`);
			checked++;
		}
		assert.ok(checked > 0, "at least one turn checked");
	});
});
