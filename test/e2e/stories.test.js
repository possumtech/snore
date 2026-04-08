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
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_TEST_MODEL;
const TIMEOUT = 300_000;

async function lastResponse(db, runAlias) {
	const runRow = await db.get_run_by_alias.get({ alias: runAlias });
	const loops = await db.get_pending_loops.all({ run_id: runRow.id });
	const latestLoop = await db.get_latest_completed_loop.get({
		run_id: runRow.id,
	});
	const allLoops = [...loops];
	if (latestLoop) allLoops.push(latestLoop);

	console.log(
		`[DEBUG lastResponse] run=${runAlias} status=${runRow.status} next_turn=${runRow.next_turn} next_loop=${runRow.next_loop}`,
	);
	console.log(
		`[DEBUG lastResponse] loops: ${JSON.stringify(allLoops.map((l) => ({ id: l.id, seq: l.sequence, status: l.status })))}`,
	);

	const summary = await db.get_latest_summary.get({
		run_id: runRow.id,
		loop_id: latestLoop?.id ?? null,
	});
	console.log(
		`[DEBUG lastResponse] summary (loop_id=${latestLoop?.id ?? null}): ${summary?.body?.slice(0, 120) ?? "NONE"}`,
	);

	if (summary?.body) return summary.body;

	const entries = await db.get_known_entries.all({ run_id: runRow.id });
	const summaries = entries.filter((e) => e.scheme === "summarize");
	const content = entries
		.filter((e) => e.scheme === "content")
		.toSorted((a, b) => b.turn - a.turn);

	console.log(
		`[DEBUG lastResponse] all summarize entries: ${JSON.stringify(summaries.map((s) => ({ path: s.path, turn: s.turn, body: s.body?.slice(0, 80) })))}`,
	);
	console.log(
		`[DEBUG lastResponse] content entries: ${content.length}, latest: ${content[0]?.body?.slice(0, 80) ?? "NONE"}`,
	);

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
async function acceptAll(client, result, db, projectRoot) {
	let current = result;
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
						if (attrs?.file && attrs?.merge) {
							const filePath = join(projectRoot, attrs.file);
							const content = await fs
								.readFile(filePath, "utf8")
								.catch(() => "");
							const blocks = attrs.merge.split(/(?=<<<<<<< SEARCH)/);
							let patched = content;
							for (const block of blocks) {
								const match = block.match(
									/<<<<<<< SEARCH\n?([\s\S]*?)\n?=======\n?([\s\S]*?)\n?>>>>>>> REPLACE/,
								);
								if (match) patched = patched.replace(match[1], match[2]);
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

			current = await client.call("run/resolve", {
				run: current.run,
				resolution: { path: p.path, action: "accept", output: "applied" },
			});
			resolves++;
		}
	}
	return current;
}

describe("E2E Stories", { concurrency: 1 }, () => {
	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-stories-${Date.now()}`);

	before(async () => {
		await fs.mkdir(join(projectRoot, "src"), { recursive: true });
		await fs.mkdir(join(projectRoot, "data"), { recursive: true });

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
		tserver = await TestServer.start(tdb.db);
		client = new AuditClient(tserver.url, tdb.db);
		await client.connect();
		await client.call("init", {
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

	// Story 1: Simple factual answer from file content.
	// Model should answer from context without needing to read.
	it("factual answer from context", { timeout: TIMEOUT }, async () => {
		const r = await client.call("ask", {
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
		const r = await client.call("ask", {
			model,
			prompt:
				"Search the web for when Mass Effect 1 was released. Save the release year as a known entry. Tell me the year.",
			noInteraction: true,
		});
		await client.assertRun(r, 200, "research");
		assertContains(await lastResponse(tdb.db, r.run), "2007", "research-year");

		const entries = await allEntries(tdb.db, r.run);
		const searched = entries.filter((e) => e.scheme === "search");
		assert.ok(searched.length > 0, "should have performed a web search");
		const known = entries.filter((e) => e.scheme === "known");
		assert.ok(known.length > 0, "should have saved discovered knowledge");
	});

	// Story 3: Autonomous file edit — model reads, edits, proposes.
	// We accept the proposal. Tests the full act lifecycle in one prompt.
	it("autonomous file edit", { timeout: TIMEOUT }, async () => {
		const r = await client.call("act", {
			model,
			prompt:
				'In src/app.js, replace the TODO comment with "// error handler configured". Read the file first to find the exact text, then use SEARCH/REPLACE.',
		});
		await client.assertRun(r, [200, 202], "edit");
		if (r.status === 202) await acceptAll(client, r, tdb.db, projectRoot);

		const runRow = await tdb.db.get_run_by_alias.get({ alias: r.run });
		const entries = await tdb.db.get_known_entries.all({
			run_id: runRow.id,
		});
		const writes = entries.filter(
			(e) => e.scheme === "set" && (e.status === 200 || e.status === 202),
		);
		assert.ok(writes.length > 0, "should have a write result");
	});

	// Story 3b: Verify accepted edits are visible on next turn.
	// The model edits a file, we accept, then ask what the file contains.
	// If the scanner doesn't pick up the disk write, the model sees stale content.
	it("accepted edits visible on next turn", { timeout: TIMEOUT }, async () => {
		const r1 = await client.call("act", {
			model,
			prompt:
				'In src/app.js, replace the TODO comment with "// error handler configured". Read the file first to find the exact text, then use SEARCH/REPLACE.',
		});
		await client.assertRun(r1, [200, 202], "edit-visible");
		if (r1.status === 202) await acceptAll(client, r1, tdb.db, projectRoot);

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
		const r2 = await client.call("ask", {
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
		const r1 = await client.call("ask", {
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

		const r2 = await client.call("ask", {
			model,
			prompt:
				"What port does src/app.js listen on? Reply ONLY with the number.",
			run: r1.run,
			noInteraction: true,
		});
		await client.assertRun(r2, 200, "coherence-2");
		assertContains(await lastResponse(tdb.db, r2.run), "8080", "coherence-2");
	});

	// Story 5: Unknown-driven investigation — one prompt, model must
	// register unknowns, investigate them, and answer.
	it("autonomous unknown investigation", { timeout: TIMEOUT }, async () => {
		const r = await client.call("ask", {
			model,
			prompt:
				"You MUST use <unknown> to register what you don't know, then use <get> to investigate. What test framework does this project use?",
			noInteraction: true,
		});
		await client.assertRun(r, [200, 202], "unknowns");
		if (r.status === 202) await acceptAll(client, r, tdb.db, projectRoot);
		const entries = await allEntries(tdb.db, r.run);
		const unknowns = entries.filter((e) => e.scheme === "unknown");
		assert.ok(unknowns.length > 0, "should have registered unknowns");
	});

	// Story 6: Lite mode — no file context, multi-turn memory.
	// One prompt that requires recalling information across turns.
	it("lite mode sustained session", { timeout: TIMEOUT }, async () => {
		const r1 = await client.call("ask", {
			model,
			prompt: "Remember the number 42. Reply with just 'OK'.",
			noContext: true,
			noInteraction: true,
		});
		await client.assertRun(r1, 200, "lite-1");

		const r2 = await client.call("ask", {
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

		const askPromise = client.call("ask", {
			model,
			prompt:
				"Carefully analyze every file in this project. Write a 500-word summary of each one. Then cross-reference all summaries.",
		});

		const deadline = Date.now() + 15_000;
		while (!runAlias && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 500));
		}

		if (runAlias) {
			await client.call("run/abort", { run: runAlias });
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
		const r1 = await client.call("act", {
			model,
			prompt: "Delete the file notes.md from the project.",
		});
		await client.assertRun(r1, [200, 202], "reject-1");

		if (r1.status === 202) {
			let current = r1;
			while (current.status === 202) {
				const next = current.proposed[0];
				current = await client.call("run/resolve", {
					run: r1.run,
					resolution: {
						path: next.path,
						action: "reject",
						output: "Do not delete.",
					},
				});
			}
		}

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

	// Story 9b: Context budget enforcement — entries demoted when over budget.
	// Writes large files, loads them, then shrinks the context window.
	// Budget enforcement should demote oldest full entries to summary.
	it("context budget demotion", { timeout: TIMEOUT }, async () => {
		// Write large files that will eat significant context
		const bigContent = `// ${"x".repeat(2000)}\n`;
		await fs.writeFile(join(projectRoot, "src/big1.js"), bigContent);
		await fs.writeFile(join(projectRoot, "src/big2.js"), bigContent);

		// Load both files at full fidelity via RPC (no model involvement)
		await client.call("get", { path: "src/big1.js", persist: true });
		await client.call("get", { path: "src/big2.js", persist: true });
		const r1 = await client.call("ask", {
			model,
			prompt: "Reply with OK.",
			noInteraction: true,
		});
		await client.assertRun(r1, 200, "budget-load");

		// Set context limit tight enough to force demotions but above the floor.
		// Measure current context and set limit to 75%.
		const budgetRun = await tdb.db.get_run_by_alias.get({ alias: r1.run });
		const budgetCtx = await tdb.db.get_promoted_token_total.get({
			run_id: budgetRun.id,
		});
		const budgetLimit = Math.max(
			6144,
			Math.ceil((budgetCtx?.total || 6144) * 0.75),
		);
		await client.call("run/config", {
			run: r1.run,
			contextLimit: budgetLimit,
		});

		// Next turn triggers budget enforcement
		const r2 = await client.call("ask", {
			model,
			prompt:
				"What is the project codename in notes.md? Reply ONLY with the word.",
			run: r1.run,
			noInteraction: true,
		});
		await client.assertRun(r2, 200, "budget-demoted");

		// Check that file entries were demoted (summary, index, or stored)
		const entries = await allEntries(tdb.db, r2.run);
		const demotedFiles = entries.filter(
			(e) =>
				e.scheme === null &&
				(e.fidelity === "summary" ||
					e.fidelity === "index" ||
					e.fidelity === "stored"),
		);
		assert.ok(
			demotedFiles.length > 0,
			"should have demoted file entries to fit budget",
		);
	});

	// Story 9c: Budget cascade under heavy known entry load.
	// Ingest many facts, shrink the context, verify the model can still
	// answer from surviving knowns. Tests the halving spiral end-to-end.
	it("budget cascade preserves recent knowns under pressure", {
		timeout: TIMEOUT,
	}, async () => {
		// First: teach the model a fact via a known entry
		let r1 = await client.call("ask", {
			model,
			prompt:
				"Save this as a known entry: <known>The speed of light is 299792458 meters per second</known>. Reply with <update>saved</update>.",
			noContext: true,
			noInteraction: true,
		});
		if (r1.status === 202)
			r1 = await acceptAll(client, r1, tdb.db, projectRoot);
		await client.assertRun(r1, 200, "cascade-save");

		// Load several large files to pressure the budget
		const bigContent = `// ${"x".repeat(3000)}\n`;
		await fs.writeFile(join(projectRoot, "src/pressure1.js"), bigContent);
		await fs.writeFile(join(projectRoot, "src/pressure2.js"), bigContent);
		await fs.writeFile(join(projectRoot, "src/pressure3.js"), bigContent);
		await client.call("get", { path: "src/pressure1.js", persist: true });
		await client.call("get", { path: "src/pressure2.js", persist: true });
		await client.call("get", { path: "src/pressure3.js", persist: true });

		// Shrink context to force cascade.
		// Measure current context and set limit to 75%.
		const cascadeRun = await tdb.db.get_run_by_alias.get({ alias: r1.run });
		const cascadeCtx = await tdb.db.get_promoted_token_total.get({
			run_id: cascadeRun.id,
		});
		const cascadeLimit = Math.max(
			6144,
			Math.ceil((cascadeCtx?.total || 6144) * 0.75),
		);
		await client.call("run/config", {
			run: r1.run,
			contextLimit: cascadeLimit,
		});

		// Ask about the fact — cascade should preserve it while demoting files
		let r2 = await client.call("ask", {
			model,
			prompt:
				"What is the speed of light in meters per second? Reply ONLY with the number.",
			run: r1.run,
			noInteraction: true,
		});
		if (r2.status === 202)
			r2 = await acceptAll(client, r2, tdb.db, projectRoot);
		await client.assertRun(r2, [200, 202], "cascade-answer");

		// The known entry should have survived (full or at least visible)
		const entries = await allEntries(tdb.db, r2.run);
		const lightEntry = entries.find(
			(e) => e.scheme === "known" && e.body?.includes("299792458"),
		);
		assert.ok(lightEntry, "speed of light known entry should still exist");

		// Files should have been demoted
		const demotedFiles = entries.filter(
			(e) =>
				e.scheme === null &&
				e.path.includes("pressure") &&
				e.fidelity !== "full",
		);
		assert.ok(
			demotedFiles.length > 0,
			"pressure files should have been demoted",
		);
	});

	// Story 9d: Crunch plugin — mid-cascade summarization.
	// Creates known entries without summaries, forces cascade demotion,
	// verifies crunch fires and model can still answer from crunched context.
	it("crunch generates summaries during cascade", {
		timeout: TIMEOUT,
	}, async () => {
		// Create several known entries with substantive content but no summary attr
		const r1 = await client.call("act", {
			model,
			prompt: [
				"Save these as known entries:",
				'<known path="known://fact_gravity">Gravity accelerates objects at 9.8 meters per second squared on Earth surface</known>',
				'<known path="known://fact_water">Water boils at 100 degrees Celsius at standard atmospheric pressure at sea level</known>',
				'<known path="known://fact_pi">Pi is approximately 3.14159265358979 and is the ratio of circumference to diameter</known>',
				"<update>Facts saved.</update>",
			].join("\n"),
			noInteraction: true,
		});
		await client.assertRun(r1, [200, 202], "crunch-save");
		if (r1.status === 202) await acceptAll(client, r1, tdb.db, projectRoot);

		// Verify entries exist without summary attributes
		const preCrunch = await allEntries(tdb.db, r1.run);
		const facts = preCrunch.filter((e) => e.path?.startsWith("known://fact_"));
		assert.ok(facts.length >= 3, "should have saved 3 fact entries");

		// Load large files to pressure context
		const bigContent = `// ${"x".repeat(3000)}\n`;
		await fs.writeFile(join(projectRoot, "src/crunch1.js"), bigContent);
		await fs.writeFile(join(projectRoot, "src/crunch2.js"), bigContent);
		await client.call("get", { path: "src/crunch1.js", persist: true });
		await client.call("get", { path: "src/crunch2.js", persist: true });

		// Shrink context to force tier 1 cascade (full→summary triggers crunch).
		// Measure current context and set limit to 75% — forces demotion while
		// holding the irreducible floor (system prompt + tool docs).
		const crunchRun = await tdb.db.get_run_by_alias.get({ alias: r1.run });
		const crunchCtx = await tdb.db.get_promoted_token_total.get({
			run_id: crunchRun.id,
		});
		const crunchLimit = Math.max(
			6144,
			Math.ceil((crunchCtx?.total || 6144) * 0.75),
		);
		await client.call("run/config", {
			run: r1.run,
			contextLimit: crunchLimit,
		});

		// Ask about one of the facts — model must answer from crunched context
		const r2 = await client.call("ask", {
			model,
			prompt:
				"What is the boiling point of water in Celsius? Reply ONLY with the number.",
			run: r1.run,
			noInteraction: true,
		});
		await client.assertRun(r2, 200, "crunch-answer");
		assertContains(await lastResponse(tdb.db, r2.run), "100", "crunch-answer");

		// Check that crunch wrote summary attributes on demoted entries
		const postCrunch = await allEntries(tdb.db, r2.run);
		const crunched = postCrunch.filter(
			(e) => e.path?.startsWith("known://fact_") && e.fidelity !== "full",
		);
		// At least some facts should have been demoted by the cascade
		// If crunch fired, they should have summary attributes
		if (crunched.length > 0) {
			const withSummary = crunched.filter((e) => {
				const attrs =
					typeof e.attributes === "string"
						? JSON.parse(e.attributes)
						: e.attributes;
				return typeof attrs?.summary === "string" && attrs.summary.length > 0;
			});
			assert.ok(
				withSummary.length > 0,
				"crunch should have generated summaries for demoted known entries",
			);
		}
	});

	// Story 10: Web search — model searches, gets results, answers from them.
	it("autonomous web search", { timeout: TIMEOUT }, async () => {
		const r = await client.call("ask", {
			model,
			prompt:
				'Search the web for "Mitch Hedberg death date" and tell me when he died.',
			noInteraction: true,
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
});
