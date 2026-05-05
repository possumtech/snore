/**
 * LLM-fetch timeout becomes a 504 strike, not a loop-level 500.
 *
 * Regression for the gpt2-codegolf turn-9 pathology: a fetch hitting
 * AbortSignal.timeout(FETCH_TIMEOUT) inside the LLM call propagates
 * an AbortError. Without the TurnExecutor catch, the error escapes
 * to AgentLoop's outer catch and the run dies at status=500, losing
 * every prior productive turn. The catch translates it to a 504
 * error.log strike — single timeout = recoverable, MAX_STRIKES in a
 * row = clean abandon at 499.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const TERMINAL = new Set([200, 204, 413, 422, 499, 500]);

function timeoutError() {
	const err = new Error("The operation was aborted due to timeout");
	err.name = "TimeoutError";
	return err;
}

describe("LLM fetch timeout → 504 strike (@plugins_run_loop_lifecycle)", () => {
	let tdb, tserver, projectRoot;

	before(async () => {
		tdb = await TestDb.create("llm_timeout_strike");
		projectRoot = join(tmpdir(), `llm_timeout_${Date.now()}`);
		await fs.mkdir(projectRoot, { recursive: true });

		// Provider whose first call throws TimeoutError, then succeeds.
		// Mimics the real-world shape: a single slow LLM call hits its
		// AbortSignal.timeout, subsequent calls recover.
		let calls = 0;
		tdb.hooks.llm.providers.push({
			name: "stub-timeout-once",
			matches: (wire) => wire === "stub-timeout-once",
			completion: async () => {
				calls++;
				if (calls === 1) throw timeoutError();
				return {
					choices: [
						{
							message: {
								role: "assistant",
								content: '<update status="200">done</update>',
							},
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 10,
						completion_tokens: 5,
						total_tokens: 15,
					},
					model: "stub-timeout-once",
				};
			},
			getContextSize: async () => 32768,
		});

		await tdb.db.upsert_model.get({
			alias: "stub-timeout-once",
			actual: "stub-timeout-once",
			context_length: 32768,
		});

		tserver = await TestServer.start(tdb);
	});

	after(async () => {
		await tdb?.cleanup();
	});

	it("a single LLM TimeoutError lands as 504 strike, run continues to terminal", async () => {
		const client = new RpcClient(tserver.url);
		await client.connect();
		await client.call("rummy/hello", {
			name: "timeout-strike",
			projectRoot,
			clientVersion: "2.0.0",
		});
		const res = await client.call("set", {
			path: "run://",
			body: "verify timeout becomes a strike",
			attributes: { model: "stub-timeout-once", mode: "ask" },
		});
		const alias = res.alias;

		// Wait for run to reach a terminal status. The first turn's LLM
		// call throws TimeoutError → 504 strike → loop continues. The
		// second turn's LLM call returns a terminal update → run ends
		// cleanly. Without the catch, run would have crashed at 500
		// after the first turn.
		const deadline = Date.now() + 15000;
		let runRow;
		while (Date.now() < deadline) {
			runRow = await tdb.db.get_run_by_alias.get({ alias });
			if (runRow && TERMINAL.has(runRow.status)) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		assert.ok(
			runRow && TERMINAL.has(runRow.status),
			`run reached terminal status; got ${runRow?.status}`,
		);
		assert.notEqual(
			runRow.status,
			500,
			"timeout must NOT propagate as loop-level 500",
		);

		// Verify the 504 strike entry was written for turn 1.
		const errorRows = await tdb.db.get_entries_by_pattern.all({
			run_id: runRow.id,
			path: "log://turn_1/error/*",
			body: null,
			limit: null,
			offset: null,
			since: null,
			include_audit_schemes: 1,
		});
		const timeoutEntry = errorRows.find((e) => {
			const attrs =
				typeof e.attributes === "string"
					? JSON.parse(e.attributes)
					: e.attributes;
			return attrs?.status === 504;
		});
		assert.ok(
			timeoutEntry,
			`504 strike entry for turn 1; got ${errorRows.length} error entries: ${errorRows.map((e) => e.path).join(", ")}`,
		);
		assert.match(
			timeoutEntry.body,
			/timed out/i,
			"strike body names the timeout",
		);

		await client.close();
	});
});
