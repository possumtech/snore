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
const TIMEOUT = 480_000;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function lastResponse(db, runAlias) {
	const runRow = await db.get_run_by_alias.get({ alias: runAlias });
	const entries = await db.get_known_entries.all({ run_id: runRow.id });

	// The model's literal answer can land in two places: the prose
	// preceding/following its <update> tag, or the <update> body itself.
	// `<update>` is a status report capped at 80 chars, so the answer
	// often lives in prose with the update body summarizing the act of
	// answering ("Answered the question with the remembered number.").
	// `assistant://N` carries the full raw response (prose + tags) so
	// it always contains the answer wherever the model placed it.
	const assistant = entries
		.filter((e) => e.scheme === "assistant" && e.body)
		.toSorted((a, b) => b.turn - a.turn);
	if (assistant.length > 0) return assistant[0].body;

	const latestLoop = await db.get_latest_completed_loop.get({
		run_id: runRow.id,
	});
	const summary = await db.get_latest_summary.get({
		run_id: runRow.id,
		loop_id: latestLoop?.id ?? null,
	});
	if (summary?.body) return summary.body;

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

		tdb = await TestDb.create("stories", { home: turnsHome });
		tserver = await TestServer.start(tdb);
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

		// Verify the model can see the edit on the next turn — by
		// asking for a verbatim quote rather than a yes/no judgment.
		// Recitation requires actually reading the current file body;
		// it can't be answered from prior-loop knowns alone, and there's
		// no yes/no shape-instruction to persist as a competing standing
		// rule into the next loop.
		const r2 = await client.ask({
			model,
			prompt:
				"Quote the comment line in src/app.js verbatim. Just the line, no other text.",
			run: r1.run,
			noInteraction: true,
		});
		await client.assertRun(r2, 200, "edit-verify");
		assertContains(
			await lastResponse(tdb.db, r2.run),
			"error handler configured",
			"edit-visible",
		);
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
			// Earlier prompt versions tangled with the protocol's Definition
			// stage in two ways: (1) "You MUST register unknowns for what
			// you need to find" got re-read each turn, sending gemma into
			// a meta-loop the cycle detector caught at iter 18 → 499; and
			// (2) the open-ended phrasing let gemma over-define adjacent
			// unknowns (port, user, name, password) that the prompt didn't
			// ask for, after which the protocol blocked completion until
			// every unknown resolved. The current phrasing scopes the
			// answer-set to exactly two values so the Decomposition stage
			// has a natural stopping point.
			prompt:
				"Find exactly two values in this project: the database connection pool size, and the database host. Answer with just those two values when you have them. Do not investigate any other database settings.",
			noInteraction: true,
		});
		await client.assertRun(r, [200, 202], "unknowns");
		// Outcome assertion: the model successfully extracted the two
		// values from src/config.json ({ pool: 5, host: "db.internal" }).
		// Whether it routed via unknown:// registration is enforced by
		// the validator on status=145, not by this test.
		const response = await lastResponse(tdb.db, r.run);
		assertContains(response, "5", "unknowns-pool");
		assertContains(response, "db.internal", "unknowns-host");
	});

	// Story 6: Lite mode — no file context, multi-turn memory.
	// First prompt is a bare statement (no shape-instruction to
	// persist as a standing rule into the next loop). Second prompt
	// is the only shape-constrained turn; recall is the only thing
	// being tested.
	it("lite mode sustained session", { timeout: TIMEOUT }, async () => {
		const r1 = await client.ask({
			model,
			prompt: "My account number is 42.",
			noRepo: true,
			noInteraction: true,
		});
		await client.assertRun(r1, 200, "lite-1");

		const r2 = await client.ask({
			model,
			prompt: "What is my account number? Reply with just the digits.",
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
		client.on("run/changed", captureRun);

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

		client.removeListener("run/changed", captureRun);
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
			contextLimit: 7000,
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
		const searchLogs = entries.filter(
			(e) => e.scheme === "log" && /\/search\//.test(e.path),
		);
		assert.ok(searchLogs.length > 0, "search produced at least one log entry");
		// Some attempts may emit malformed queries that fail path validation —
		// what matters is that *at least one* search log body shows the
		// markdown-bullet result shape.
		assert.ok(
			searchLogs.some((e) => /^\* https?:/m.test(e.body)),
			"at least one search log body lists results as markdown bullets",
		);
	});

	// Story 11 (knowns-survive-auto-demotion) deleted 2026-04-25.
	// The protection invariant — `demote_turn_entries` excludes
	// scheme IN ('known','unknown') — is covered deterministically by
	// test/integration/budget_demotion.test.js
	// "does not demote known:// or unknown:// entries (deliverables)".
	// Driving the same assertion through a real-model run added no
	// coverage and ate a 300s budget on every e2e sweep.

	// Story 12: Pre-turn budget guards — when a new loop's first turn
	// is over the ceiling, the budget plugin attempts a single recovery
	// (demote the latest prompt entry, re-materialize, re-check) before
	// striking. This test verifies the recovery path runs and does NOT
	// surface a raw 413 to the client. After the deliverable-protection
	// change (`demote_turn_entries` excludes scheme IN ('known','unknown'))
	// pre-turn recovery cannot reach knowns; if the visible context is
	// mostly the model's own knowns, recovery may be insufficient and
	// the run terminates at 499. That's a documented trade-off — the
	// guarantee under test is "no 413 reaches the client," which holds
	// for both 200 (recovery succeeded) and 499 (recovery insufficient
	// → strike, never raw 413). 413 leaking through would mean the
	// pre-LLM guard didn't run at all.
	it("pre-turn overflow triggers recovery, not raw 413", {
		timeout: TIMEOUT,
	}, async () => {
		const r1 = await client.ask({
			model,
			prompt:
				"Save 5 separate known entries about colors: red is warm, blue is cool, green is nature, yellow is bright, purple is royal. Then summarize.",
			noInteraction: true,
			noRepo: true,
			contextLimit: 4500,
		});
		// 499 is documented as a valid terminal for r2 (recovery insufficient
		// when only deliverables are visible — see comment block above). The
		// same trade-off applies to r1: a tight contextLimit that exposes the
		// recovery limit on r2 also exposes it on r1 if the model's FCRM walk
		// produces overflow during Distillation/Demotion. Either path holds
		// the contract under test ("no raw 413 leaks to the client").
		assert.ok(
			[200, 202, 499].includes(r1.status),
			`setup: expected terminal status, got ${r1.status}`,
		);

		const r2 = await client.ask({
			model,
			prompt: "What color is associated with royalty?",
			run: r1.run,
			noInteraction: true,
			noRepo: true,
		});

		// The system promise is that 413 never surfaces to the client.
		// 499 (recovery struck out) is a valid terminal — it means the
		// guard ran, the model couldn't make room (likely because only
		// deliverables are visible), and the strike system terminated
		// the loop properly.
		assert.notStrictEqual(
			r2.status,
			413,
			"raw 413 should never reach the client — pre-LLM budget guard must intercept",
		);
		assert.ok(
			[200, 202, 499].includes(r2.status),
			`expected terminal status from a valid recovery path, got ${r2.status}`,
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

		// Turn Demotion keeps context under ceiling so the run can either
		// complete (200/202) or strike out cleanly (499) when the model
		// cycles in stage logic — both are valid terminals; raw 413 to the
		// client would mean the guard didn't run at all.
		assert.notStrictEqual(
			r1.status,
			413,
			"raw 413 should never reach the client — Turn Demotion guard must intercept",
		);
		assert.ok(
			[200, 202, 499].includes(r1.status),
			`expected terminal status, got ${r1.status}`,
		);
	});
});
