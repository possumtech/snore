/**
 * LongMemEval runner for Rummy.
 *
 * Runs live agent sessions against the LongMemEval dataset.
 * Each benchmark row: create a run, feed conversation history
 * via ask prompts, then quiz the agent on the question.
 *
 * Usage:
 *   node test/lme/runner.js                                    # all rows
 *   node test/lme/runner.js --split longmemeval_s_cleaned      # specific split
 *   node test/lme/runner.js --row 0                            # single row
 *   node test/lme/runner.js --row 0-4                          # row range
 *   node test/lme/runner.js --chunk-size 4000                  # chars per chunk
 *   node test/lme/runner.js --type knowledge-update            # filter by question type
 */
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";
import { evaluate, scoreRow } from "./evaluate.js";
import { printReport } from "./report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const RESULTS_DIR = join(__dirname, "results");

const DEFAULT_SPLITS = ["longmemeval_s_cleaned"];

const { values: args } = parseArgs({
	options: {
		split: { type: "string" },
		row: { type: "string" },
		"chunk-size": { type: "string", default: "4000" },
		model: { type: "string" },
		type: { type: "string" },
	},
	strict: false,
});

const CHUNK_SIZE = Number.parseInt(args["chunk-size"], 10);
const MODEL = args.model || process.env.RUMMY_TEST_MODEL;
const TYPE_FILTER = args.type || null;

function parseRowRange(spec) {
	if (!spec) return null;
	if (spec.includes("-")) {
		const [start, end] = spec.split("-").map(Number);
		return { start, end };
	}
	const n = Number(spec);
	return { start: n, end: n };
}

function loadSplit(split) {
	const path = join(DATA_DIR, `${split}.ndjson`);
	if (!existsSync(path))
		throw new Error(`Missing data: ${path}\nRun: npm run test:lme:get`);
	const content = readFileSync(path, "utf8");
	return content
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * Format a single session as readable text with timestamp.
 */
function formatSession(session, date, sessionId) {
	const header = date ? `[Session: ${date}]` : `[Session: ${sessionId}]`;
	const keys = Object.keys(session).sort((a, b) => Number(a) - Number(b));
	const turns = keys
		.map((k) => {
			const t = session[k];
			return `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`;
		})
		.join("\n");
	return `${header}\n${turns}\n\n`;
}

/**
 * Chunk sessions into text blocks, respecting session boundaries.
 * Sessions are never split mid-conversation.
 */
function chunkSessions(sessions, dates, sessionIds, maxSize) {
	const chunks = [];
	let current = "";

	for (let i = 0; i < sessions.length; i++) {
		const text = formatSession(sessions[i], dates?.[i], sessionIds?.[i]);
		if (current.length + text.length > maxSize && current.length > 0) {
			chunks.push(current);
			current = "";
		}
		current += text;
	}
	if (current) chunks.push(current);
	return chunks;
}

async function resolveAll(client, result) {
	let current = result;
	let resolves = 0;
	while (
		current.status === 202 &&
		current.proposed?.length > 0 &&
		resolves < 50
	) {
		for (const p of current.proposed) {
			if (resolves >= 50) break;
			current = await client.call("run/resolve", {
				run: current.run,
				resolution: {
					path: p.path,
					action: "accept",
					output: p.path?.startsWith("ask_user://") ? "N/A" : "",
				},
			});
			resolves++;
		}
	}
	return current;
}

async function ingestSessions(client, model, run, sessions, dates, sessionIds) {
	for (let i = 0; i < sessions.length; i++) {
		const session = sessions[i];
		const date = dates?.[i] || `session ${i + 1}`;
		const total = sessions.length;
		const text = formatSession(session, date, sessionIds?.[i]);
		const prompt = [
			`Conversation ${i + 1} of ${total} (${date}).`,
			"Read and remember any new key facts.",
			"",
			text,
		].join("\n");

		let r = await client.call("ask", {
			model,
			prompt,
			run,
			noContext: true,
			noInteraction: true,
		});
		if (r.status === 202) r = await resolveAll(client, r);
		if (r.status >= 500) {
			console.warn(
				`    session ${i + 1}/${total} failed: ${r.error || "unknown"}`,
			);
		}
		const preview = text.replace(/\n/g, " ").slice(0, 80);
		console.log(`    ${i + 1}/${total} ${date}: ${preview}`);
	}
	console.log(`    ingested ${sessions.length} sessions`);
}

async function askQuestion(client, db, model, run, question, questionDate) {
	const preRun = await db.get_run_by_alias.get({ alias: run });
	const turnBefore = preRun.next_turn;

	const dateLine = questionDate ? `(Current date: ${questionDate})` : "";
	const prompt = [
		"Answer this question from memory.",
		dateLine,
		"<summarize>[your answer]</summarize>",
		"",
		question,
	]
		.filter(Boolean)
		.join("\n");

	let r = await client.call("ask", { model, prompt, run, noInteraction: true });
	if (r.status === 202) r = await resolveAll(client, r);

	if (r.status >= 500) return "";

	const runRow = await db.get_run_by_alias.get({ alias: r.run });
	const entries = await db.get_known_entries.all({ run_id: runRow.id });
	const newEntries = entries.filter((e) => e.turn >= turnBefore);

	const summary = newEntries.find((e) => e.scheme === "summarize");
	if (summary?.body) return summary.body;

	const assistant = newEntries
		.filter((e) => e.scheme === "assistant")
		.toSorted((a, b) => b.turn - a.turn)[0];
	if (assistant?.body) return assistant.body.replace(/<[^>]+>/g, " ").trim();

	const content = newEntries.find((e) => e.scheme === "content");
	if (content?.body) return content.body;

	return "";
}

async function judgeAnswer(client, db, model, question, expected, response) {
	const prompt = [
		"You are a strict evaluator. Does the response correctly answer the question?",
		"",
		`Question: ${question}`,
		`Expected answer: ${expected}`,
		`Actual response: ${response}`,
		"",
		"<summarize>YES or NO, then a one-sentence reason</summarize>",
	].join("\n");

	let r = await client.call("ask", {
		model,
		prompt,
		noContext: true,
		noInteraction: true,
	});
	if (r.status === 202) r = await resolveAll(client, r);
	if (r.status >= 500) return { pass: false, reason: "judge call failed" };

	const alias = r.run;
	const dbRun = await db.get_run_by_alias.get({ alias });
	let judgeText = "";
	if (dbRun) {
		const entries = await db.get_known_entries.all({ run_id: dbRun.id });
		const summary = entries.find((e) => e.scheme === "summarize");
		if (summary?.body) judgeText = summary.body;
		if (!judgeText) {
			const asst = entries
				.filter((e) => e.scheme === "assistant")
				.toSorted((a, b) => b.turn - a.turn)[0];
			if (asst?.body) judgeText = asst.body.replace(/<[^>]+>/g, " ").trim();
		}
	}

	const normalized = judgeText.toLowerCase().trim();
	const yesIdx = normalized.search(/\byes\b/);
	const noIdx = normalized.search(/\bno\b/);
	const pass = yesIdx !== -1 && (noIdx === -1 || yesIdx < noIdx);
	return { pass, reason: judgeText.slice(0, 200) };
}

async function runRow(client, db, model, split, rowIndex, row) {
	const questionType = row.question_type || "unknown";
	const sessionCount = row.haystack_sessions?.length ?? 0;
	console.log(
		`\n  [${split}:${rowIndex}] type=${questionType} sessions=${sessionCount} q=${row.question_id}`,
	);

	const startTime = Date.now();

	const splitAbbrev = split.replace(/longmemeval_|_cleaned/g, "").slice(0, 4);
	const initR = await client.call("ask", {
		model,
		prompt:
			"You are being evaluated on long-term memory. Incoming conversation history follows. Use <known> to save facts about the user. Reply with <summarize>ready</summarize>.",
		noContext: true,
		noInteraction: true,
	});
	let run = initR.run;

	const lmeAlias = `lme_${splitAbbrev}_${rowIndex}`;
	try {
		await client.call("run/rename", { run, name: lmeAlias });
		run = lmeAlias;
	} catch {}

	await ingestSessions(
		client,
		model,
		run,
		row.haystack_sessions,
		row.haystack_dates,
		row.haystack_session_ids,
	);

	const answer =
		typeof row.answer === "string" ? row.answer : String(row.answer);
	const validAnswers = [answer];
	const response = await askQuestion(
		client,
		db,
		model,
		run,
		row.question,
		row.question_date,
	);
	let { pass, matched } = evaluate(response, validAnswers);
	let matchType = pass ? "exact" : null;
	let judgeReason = null;

	if (!pass && response) {
		const verdict = await judgeAnswer(
			client,
			db,
			model,
			row.question,
			answer,
			response,
		);
		if (verdict.pass) {
			pass = true;
			matchType = "judged";
			judgeReason = verdict.reason;
		} else {
			judgeReason = verdict.reason;
		}
	}

	const questionResults = [
		{
			question: row.question,
			response,
			answers: validAnswers,
			pass,
			matchType,
			matched,
			judgeReason,
		},
	];

	const endTime = Date.now();
	const score = scoreRow(questionResults);

	const runRow2 = await db.get_run_by_alias.get({ alias: run });
	const usage = await db.get_run_usage.get({ run_id: runRow2.id });

	const mark = pass ? "✓" : "✗";
	const matchLabel = matchType === "judged" ? " (judged)" : "";
	console.log(
		`    ${mark}${matchLabel} ${(score.accuracy * 100).toFixed(0)}% — ${((endTime - startTime) / 1000).toFixed(0)}s`,
	);

	return {
		split,
		rowIndex,
		questionId: row.question_id,
		questionType,
		score,
		usage: {
			prompt_tokens: usage?.prompt_tokens ?? 0,
			completion_tokens: usage?.completion_tokens ?? 0,
			cost: usage?.cost ?? 0,
		},
		timing: { duration_ms: endTime - startTime },
		questions: questionResults,
	};
}

async function main() {
	if (!MODEL) {
		console.error("No model configured. Set RUMMY_TEST_MODEL in .env.test");
		process.exit(1);
	}

	const splits = args.split ? [args.split] : DEFAULT_SPLITS;
	const rowRange = parseRowRange(args.row);

	console.log(`LongMemEval Runner`);
	console.log(`Model: ${MODEL}`);
	console.log(`Chunk size: ${CHUNK_SIZE} chars`);
	console.log(`Splits: ${splits.join(", ")}`);
	if (rowRange) console.log(`Rows: ${rowRange.start}-${rowRange.end}`);
	if (TYPE_FILTER) console.log(`Type filter: ${TYPE_FILTER}`);

	for (const split of splits) {
		const path = join(DATA_DIR, `${split}.ndjson`);
		if (!existsSync(path)) {
			console.error(`Missing: ${path}\nRun: npm run test:lme:get`);
			process.exit(1);
		}
	}

	await fs.mkdir(RESULTS_DIR, { recursive: true });
	await fs.mkdir("/tmp/rummy-lme", { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runDir = join(RESULTS_DIR, timestamp);
	await fs.mkdir(runDir, { recursive: true });

	process.env.RUMMY_HOME = runDir;

	const dbPath = join(runDir, "lme.db");
	const tdb = await TestDb.createAt(dbPath, "lme");
	const tserver = await TestServer.start(tdb.db);
	const client = new AuditClient(tserver.url, tdb.db);
	await client.connect();
	await client.call("init", { name: "LME", projectRoot: "/tmp/rummy-lme" });

	console.log(`Database: ${dbPath}`);

	const allResults = [];
	const resultsPath = join(runDir, "results.ndjson");

	try {
		for (const split of splits) {
			console.log(`\n${"═".repeat(58)}`);
			console.log(`Split: ${split}`);
			console.log(`${"═".repeat(58)}`);

			let rows = loadSplit(split);

			if (TYPE_FILTER) {
				rows = rows.filter((r) => r.question_type === TYPE_FILTER);
				console.log(
					`  Filtered to ${rows.length} rows of type: ${TYPE_FILTER}`,
				);
			}

			const start = rowRange?.start ?? 0;
			const end = Math.min(rowRange?.end ?? rows.length - 1, rows.length - 1);

			for (let i = start; i <= end; i++) {
				const result = await runRow(client, tdb.db, MODEL, split, i, rows[i]);
				allResults.push(result);

				await fs.appendFile(resultsPath, `${JSON.stringify(result)}\n`);
			}
		}
	} finally {
		await client?.close();
		await tserver?.stop();
		await tdb.cleanup();
	}

	printReport(allResults);
	console.log(`\nResults:  ${resultsPath}`);
	console.log(`Database: ${join(runDir, "lme.db")}`);
	console.log(`Run log:  ${join(runDir, "last_run.txt")}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
