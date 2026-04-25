/**
 * Story-driven E2E tests.
 *
 * Each test sends ONE prompt and lets the model run autonomously.
 * No micro-managing turns. No hand-holding. The model uses tools,
 * gets <progress> continuations, and completes on its own.
 *
 * Assertions target final outcomes — if the answer is correct, the
 * story succeeded regardless of how many turns it took.
 */
import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_TEST_MODEL;
const TIMEOUT = 300_000;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function lastResponse(db, runAlias) {
	const runRow = await db.get_run_by_alias.get({ alias: runAlias });
	const latestLoop = await db.get_latest_completed_loop.get({
		run_id: runRow.id,
	});

	// Terminal update (status=200) — the definitive answer
	const summary = await db.get_latest_summary.get({
		run_id: runRow.id,
		loop_id: latestLoop?.id ?? null,
	});
	if (summary?.body) return summary.body;

	// Fallback: content entry (raw model text, healed response)
	const entries = await db.get_known_entries.all({ run_id: runRow.id });
	const content = entries
		.filter((e) => e.scheme === "content")
		.toSorted((a, b) => b.turn - a.turn);
	if (content.length > 0) return content[0].body;

	return "";
}

async function allEntries(db, runAlias) {
	const runRow = await db.get_run_by_alias.get({ alias: runAlias });
	return db.get_known_entries.all({ run_id: runRow.id });
}

function assertContains(text, substring, label) {
	assert.ok(
		text.toLowerCase().includes(substring.toLowerCase()),
		`${label}: expected "${substring}" in response, got: "${text.slice(0, 200)}"`,
	);
}

/** Accept all proposed entries, applying file edits to disk. */
async function _acceptAll(client, result, db, projectRoot) {
	const current = result;
	let resolves = 0;
	while (current.status === 202 && resolves < 15) {
		for (const p of current.proposed) {
			if (resolves >= 15) break;

			// Apply file edits to disk before accepting
			if (p.path?.startsWith("set://") && projectRoot) {
				const runRow = await db.get_run_by_alias.get({ alias: current.run });
				if (runRow) {
					const entries = await db.get_known_entries.all({ run_id: runRow.id });
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
							for (const block of blocks) {
								const match = block.match(
									/<<<<<<< SEARCH\n?([\s\S]*?)\n?=======\n?([\s\S]*?)\n?>>>>>>> REPLACE/,
								);
								if (!match) continue;
								if (match[1] === "") {
									patched = match[2];
								} else {
									patched = patched.replace(match[1], match[2]);
								}
							}
							if (patched !== content) await fs.writeFile(filePath, patched);
						}
					}
				}
			}

			// Apply rm to disk before accepting
			if (p.path?.startsWith("rm://") && projectRoot) {
				const runRow = await db.get_run_by_alias.get({ alias: current.run });
				if (runRow) {
					const entries = await db.get_known_entries.all({ run_id: runRow.id });
					const rmEntry = entries.find((e) => e.path === p.path);
					if (rmEntry) {
						const attrs =
							typeof rmEntry.attributes === "string"
								? JSON.parse(rmEntry.attributes)
								: rmEntry.attributes;
						if (attrs?.path) {
							await fs.unlink(join(projectRoot, attrs.path)).catch(() => {});
						}
					}
				}
			}

			await client.resolveProposal(current.run, {
				path: p.path,
				action: "accept",
				output: "applied",
			});
			resolves++;
		}
	}
	return current;
}

describe("E2E Stories (@dispatch_path, @resolution, @unified_api, @rpc_methods, @plugins_rpc, @plugins_rpc_wire_format, @plugins_rpc_primitives, @rpc_plugin)", {
	concurrency: 1,
}, () => {
	let tdb, tserver, client;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const projectRoot = join(tmpdir(), `rummy-stories-${Date.now()}`);
	const turnsHome = join(__dirname, "turns", `stories_${stamp}`);

	before(async () => {
		await fs.mkdir(join(projectRoot, "src"), { recursive: true });
		await fs.mkdir(join(projectRoot, "data"), { recursive: true });
		await fs.mkdir(turnsHome, { recursive: true });

		await fs.writeFile(
			join(projectRoot, "src/app.js"),
			"const express = require('express');\nconst app = express();\napp.listen(8080);\n// TODO: add error handling\n",
		);
		await fs.writeFile(
			join(projectRoot, "src/config.json"),
			JSON.stringify({ db: "postgres", pool: 5, host: "db.internal" }, null, 2),
		);
		await fs.writeFile(
			join(projectRoot, "src/utils.js"),
			"export function greet() { return 'hello'; }\nexport function add(a, b) { return a + b; }\n",
		);
		await fs.writeFile(
			join(projectRoot, "notes.md"),
			"The project codename is: phoenix\n",
		);
		await fs.writeFile(
			join(projectRoot, "data/users.json"),
			JSON.stringify(
				[
					{ name: "Alice", role: "admin" },
					{ name: "Bob", role: "viewer" },
				],
				null,
				2,
			),
		);

		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);

		tdb = await TestDb.create("stories");
		tserver = await TestServer.start(tdb, { home: turnsHome });
		client = new AuditClient(tserver.url, tdb.db, { projectRoot });
		await client.connect();
		await client.call("rummy/hello", {
			name: "StoriesTest",
			projectRoot,
		});
	});

	after(async () => {
		await client?.close();
		await tserver?.stop();
		await tdb?.cleanup();
		await fs.rm(projectRoot, { recursive: true, force: true });
	});

	// Reset project fixtures between tests so each starts from the same
	// disk state. Previous tests' <set> proposals modify files in place,
	// which otherwise bleeds expected content across the suite.
	beforeEach(async () => {
		await fs.writeFile(
			join(projectRoot, "src/app.js"),
			"const express = require('express');\nconst app = express();\napp.listen(8080);\n// TODO: add error handling\n",
		);
		await fs.writeFile(
			join(projectRoot, "src/config.json"),
			JSON.stringify({ db: "postgres", pool: 5, host: "db.internal" }, null, 2),
		);
		await fs.writeFile(
			join(projectRoot, "src/utils.js"),
			"export function greet() { return 'hello'; }\nexport function add(a, b) { return a + b; }\n",
		);
		await fs.writeFile(
			join(projectRoot, "notes.md"),
			"The project codename is: phoenix\n",
		);
	});

	// Story 1: Simple factual answer from file content.
	// Model should answer from context without needing to read.
	it("factual answer from context", { timeout: TIMEOUT }, async () => {
		const r = await client.ask({
			model,
			prompt:
				"What is the project codename in notes.md? Reply ONLY with the word.",
			noInteraction: true,
		});
		await client.assertRun(r, 200, "factual");
		assertContains(await lastResponse(tdb.db, r.run), "phoenix", "factual");
	});

	// Story 2: Research — model searches the web, discovers information
	// not in context, and saves it as knowledge. ONE prompt.
	it("autonomous research session", { timeout: TIMEOUT }, async () => {
		const r = await client.ask({
			model,
			prompt:
				"Search the web for when Mass Effect 1 was released. Save the release year as a known entry. Tell me the year.",
			noInteraction: true,
		});
		await client.assertRun(r, 200, "research");
		assertContains(await lastResponse(tdb.db, r.run), "2007", "research-year");

		const entries = await allEntries(tdb.db, r.run);
		const searched = entries.filter((e) =>
			/^log:\/\/turn_\d+\/search\//.test(e.path),
		);
		assert.ok(searched.length > 0, "should have performed a web search");
		const known = entries.filter((e) => e.scheme === "known");
		assert.ok(known.length > 0, "should have saved discovered knowledge");
	});

	// Story 3: Autonomous file edit — model reads, edits, proposes.
	// We accept the proposal. Tests the full act lifecycle in one prompt.
	it("autonomous file edit", { timeout: TIMEOUT }, async () => {
		const r = await client.act({
			model,
			prompt:
				'In src/app.js, replace the TODO comment with "// error handler configured". Read the file first to find the exact text, then use SEARCH/REPLACE.',
		});
		await client.assertRun(r, [200, 202], "edit");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: r.run });
		const entries = await tdb.db.get_known_entries.all({
			run_id: runRow.id,
		});
		const writes = entries.filter(
			(e) =>
				/^log:\/\/turn_\d+\/set\//.test(e.path) &&
				(e.state === "resolved" || e.state === "proposed"),
		);
		assert.ok(writes.length > 0, "should have a write result");
	});

	// Story 3b: Verify accepted edits are visible on next turn.
	// The model edits a file, we accept, then ask what the file contains.
	// If the scanner doesn't pick up the disk write, the model sees stale content.
	it("accepted edits visible on next turn", { timeout: TIMEOUT }, async () => {
		const r1 = await client.act({
			model,
			prompt:
				'In src/app.js, replace the TODO comment with "// error handler configured". Read the file first to find the exact text, then use SEARCH/REPLACE.',
		});
		await client.assertRun(r1, [200, 202], "edit-visible");

		// Verify the edit landed on disk
		const fileContent = await fs.readFile(
			join(projectRoot, "src/app.js"),
			"utf8",
		);
		assert.ok(
			fileContent.includes("error handler configured"),
			`edit-visible: file should contain edit, got: ${fileContent.slice(0, 200)}`,
		);

		// Verify the model can see the edit on the next turn
		const r2 = await client.ask({
			model,
			prompt:
				'Read src/app.js. Does it contain "error handler configured"? One word answer: yes or no.',
			run: r1.run,
			noInteraction: true,
		});
		await client.assertRun(r2, 200, "edit-verify");
		assertContains(await lastResponse(tdb.db, r2.run), "yes", "edit-visible");
	});

	// Story 4: Prompt coherence across follow-up questions.
	// Each question is a separate ask on the same run.
	// The model must answer the LATEST question, not an earlier one.
	it("prompt coherence across questions", { timeout: TIMEOUT }, async () => {
		const r1 = await client.ask({
			model,
			prompt:
				"What is the project codename in notes.md? Reply ONLY with the word.",
			noInteraction: true,
		});
		await client.assertRun(r1, 200, "coherence-1");
		assertContains(
			await lastResponse(tdb.db, r1.run),
			"phoenix",
			"coherence-1",
		);

		const r2 = await client.ask({
			model,
			prompt:
				"How many users are in data/users.json? Reply ONLY with the number.",
			run: r1.run,
			noInteraction: true,
		});
		await client.assertRun(r2, 200, "coherence-2");
		assertContains(await lastResponse(tdb.db, r2.run), "2", "coherence-2");
	});

	// Story 5: Unknown-driven investigation — one prompt, model must
	// register unknowns, investigate them, and answer.
	// Multi-hop: needs to find config.json, read it, extract host, then answer.
	it("autonomous unknown investigation", { timeout: TIMEOUT }, async () => {
		const r = await client.ask({
			model,
			prompt:
				"Investigate this project and answer: what is the database connection pool size AND the database host? You MUST register unknowns for what you need to find, then investigate with <get>.",
			noInteraction: true,
		});
		await client.assertRun(r, [200, 202], "unknowns");
		// Check that unknowns were registered at some point (may be resolved/removed by now)
		const entries = await allEntries(tdb.db, r.run);
		const unknowns = entries.filter((e) => e.scheme === "unknown");
		const rmUnknowns = entries.filter(
			(e) =>
				/^log:\/\/turn_\d+\/rm\//.test(e.path) &&
				decodeURIComponent(e.path).includes("unknown://"),
		);
		assert.ok(
			unknowns.length > 0 || rmUnknowns.length > 0,
			"should have registered unknowns (may have been resolved and removed)",
		);
	});

	// Story 6: Lite mode — no file context, multi-turn memory.
	// One prompt that requires recalling information across turns.
	it("lite mode sustained session", { timeout: TIMEOUT }, async () => {
		const r1 = await client.ask({
			model,
			prompt: "Remember the number 42. Reply with just 'OK'.",
			noRepo: true,
			noInteraction: true,
		});
		await client.assertRun(r1, 200, "lite-1");

		const r2 = await client.ask({
			model,
			prompt:
				"What number did I tell you to remember? Reply with just the number.",
			run: r1.run,
			noInteraction: true,
		});
		await client.assertRun(r2, 200, "lite-2");
		assertContains(await lastResponse(tdb.db, r2.run), "42", "lite-recall");
	});

	// Story 7: Abort mid-flight.
	it("abort mid-flight", { timeout: TIMEOUT }, async () => {
		let runAlias = null;
		const captureRun = (p) => {
			runAlias ??= p.run;
		};
		client.on("run/progress", captureRun);
		client.on("run/state", captureRun);

		const askPromise = client.ask({
			model,
			prompt:
				"Carefully analyze every file in this project. Write a 500-word summary of each one. Then cross-reference all summaries.",
		});

		const deadline = Date.now() + 15_000;
		while (!runAlias && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 500));
		}

		if (runAlias) {
			await client.abortRun(runAlias);
		}

		const result = await askPromise;
		assert.ok(
			[499, 200, 500].includes(result.status),
			`expected terminal status, got ${result.status}`,
		);

		if (runAlias) {
			const runRow = await tdb.db.get_run_by_alias.get({ alias: runAlias });
			assert.ok(runRow.status !== 102, "run should not be stuck at running");
		}

		client.removeListener("run/progress", captureRun);
		client.removeListener("run/state", captureRun);
	});

	// Story 8: Reject a proposal, verify file survives, then accept a different one.
	it("rejection and recovery", { timeout: TIMEOUT }, async () => {
		// Reject rm proposals for notes.md via custom resolve handler.
		// Proposal paths are log://turn_N/<action>/<target> (the result-path
		// of the emitting tool). Earlier this checked `rm://` which never
		// matched any real proposal — so every rm got auto-accepted and the
		// file was always deleted regardless of the resolver's intent.
		const isRmProposal = (path) => /^log:\/\/turn_\d+\/rm\//.test(path);
		client.resolveHandler = async (c, run, proposal) => {
			const action = isRmProposal(proposal.path) ? "reject" : "accept";
			await c.resolveProposal(run, {
				path: proposal.path,
				action,
				output: action === "reject" ? "Do not delete." : "",
			});
		};

		// We don't actually need the run to gracefully terminate — the
		// invariant under test is "rejected rm did not delete the file."
		// Once any rm proposal has been rejected, the file is provably
		// safe (rm.js#onAccepted is the only path that unlinks). Bound
		// the wait at 60s; if gemma can't model rejection-as-terminal
		// and keeps emitting variants, we still prove the deletion
		// didn't happen and the test can move on without burning the
		// full 5-minute deadline.
		await client
			.act({
				model,
				prompt: "Delete the file notes.md from the project.",
				timeoutMs: 60_000,
			})
			.catch(() => null);

		client.resolveHandler = null;

		// Verify file survives on disk (rejection should not delete)
		const fileExists = await fs
			.stat(join(projectRoot, "notes.md"))
			.then(() => true)
			.catch(() => false);
		assert.ok(
			fileExists,
			"reject-survive: notes.md should still exist on disk",
		);

		const content = await fs.readFile(join(projectRoot, "notes.md"), "utf8");
		assertContains(content, "phoenix", "reject-survive");
	});

	// Story 9b: Model answers correctly under real budget pressure.
	// contextLimit forces the model to manage promotion/demotion to fit
	// the answer's source file alongside the system prompt + scaffolding.
	it("model answers under tight context limit", {
		timeout: TIMEOUT,
	}, async () => {
		const r1 = await client.ask({
			model,
			prompt:
				"What is the project codename in notes.md? Reply ONLY with the word.",
			noInteraction: true,
			contextLimit: 6000,
		});
		await client.assertRun(r1, 200, "tight-context");
		assertContains(
			await lastResponse(tdb.db, r1.run),
			"phoenix",
			"tight-context",
		);
	});

	// Story 10: Web search — model searches, gets results, answers from them.
	it("autonomous web search", { timeout: TIMEOUT }, async () => {
		const r = await client.ask({
			model,
			prompt:
				'Search the web for "Mitch Hedberg death date" and tell me when he died. Limit search results to 3.',
			noInteraction: true,
			noRepo: true,
		});
		await client.assertRun(r, 200, "search");
		assertContains(await lastResponse(tdb.db, r.run), "2005", "search-year");
		const entries = await allEntries(tdb.db, r.run);
		const searchResults = entries.filter(
			(e) => e.scheme === "http" || e.scheme === "https",
		);
		assert.ok(
			searchResults.length > 0,
			"should have search result URLs in context",
		);
		assert.ok(
			searchResults.some((e) => e.body.length > 50),
			"search results should contain meaningful snippets",
		);
	});

	// Story 11 (knowns-survive-auto-demotion) deleted 2026-04-25.
	// The protection invariant — `demote_turn_entries` excludes
	// scheme IN ('known','unknown') — is covered deterministically by
	// test/integration/budget_demotion.test.js
	// "does not demote known:// or unknown:// entries (deliverables)".
	// Driving the same assertion through a real-model run added no
	// coverage and ate a 300s budget on every e2e sweep.

	// Story 12: Pre-turn 413 recovery — context is already full when a new
	// prompt arrives. The system should give the model a chance to free space
	// (demote entries), not return 413 immediately to the client.
	it("pre-turn overflow triggers recovery, not immediate 413", {
		timeout: TIMEOUT,
	}, async () => {
		// Step 1: Create a run with a tight context and fill it with known entries
		const r1 = await client.ask({
			model,
			prompt:
				"Save 5 separate known entries about colors: red is warm, blue is cool, green is nature, yellow is bright, purple is royal. Then summarize.",
			noInteraction: true,
			noRepo: true,
			contextLimit: 4500,
		});
		assert.ok(
			[200, 202].includes(r1.status),
			`setup: expected completion, got ${r1.status}`,
		);

		// Step 2: Send another prompt on the SAME run — context is already
		// near the ceiling from step 1. This triggers a new loop whose
		// pre-turn budget check may 413. The model should get a recovery
		// chance, not an immediate 413 to the client.
		const r2 = await client.ask({
			model,
			prompt: "What color is associated with royalty?",
			run: r1.run,
			noInteraction: true,
			noRepo: true,
		});

		// The critical assertion: the model should recover, not 413
		assert.ok(
			[200, 202].includes(r2.status),
			`expected recovery, got status ${r2.status} — 413 reached client without recovery attempt`,
		);
	});

	// Story 13: Turn Demotion handles overflow from model actions.
	// Model writes entries that exceed the context, Turn Demotion fires,
	// budget entry visible to model on next turn.
	it("turn demotion fires on tight context and model continues", {
		timeout: TIMEOUT,
	}, async () => {
		const r1 = await client.ask({
			model,
			prompt:
				"Save 3 known entries: known://colors/warm with body 'red orange yellow', known://colors/cool with body 'blue green teal', known://colors/neutral with body 'gray white black'. Then summarize.",
			noInteraction: true,
			noRepo: true,
			contextLimit: 5000,
		});

		// Run should complete — Turn Demotion keeps context under ceiling
		assert.ok(
			[200, 202].includes(r1.status),
			`expected completion, got status ${r1.status}`,
		);
	});
});
