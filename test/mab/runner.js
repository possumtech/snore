/**
 * MemoryAgentBench runner for Rummy.
 *
 * Runs live agent sessions against the MAB dataset.
 * Each benchmark row: create a run, feed context chunks
 * via ask prompts, then quiz the agent on each question.
 *
 * Usage:
 *   node test/mab/runner.js                                          # all splits
 *   node test/mab/runner.js --split Accurate_Retrieval              # one split
 *   node test/mab/runner.js --split Accurate_Retrieval --row 0      # one row
 *   node test/mab/runner.js --row 0-4                               # row range
 *   node test/mab/runner.js --chunk-size 4000                       # chars per chunk
 *   node test/mab/runner.js --split Conflict_Resolution --row 0 --no-questions  # taxonomy check
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

const ALL_SPLITS = [
	"Accurate_Retrieval",
	"Test_Time_Learning",
	"Long_Range_Understanding",
	"Conflict_Resolution",
];

const { values: args } = parseArgs({
	options: {
		split: { type: "string" },
		row: { type: "string" },
		"chunk-size": { type: "string", default: "4000" },
		model: { type: "string" },
		"context-limit": { type: "string" },
		"no-questions": { type: "boolean", default: false },
		"row-delay": { type: "string", default: "0" },
	},
	strict: false,
});

const CHUNK_SIZE = Number.parseInt(args["chunk-size"], 10);
const MODEL = args.model || process.env.RUMMY_TEST_MODEL;
const CONTEXT_LIMIT = args["context-limit"]
	? Number.parseInt(args["context-limit"], 10)
	: process.env.RUMMY_CONTEXT_LIMIT
		? Number.parseInt(process.env.RUMMY_CONTEXT_LIMIT, 10)
		: null;
const TAXONOMY_ONLY = args["no-questions"] === true;
const ROW_DELAY_MS = Number.parseInt(args["row-delay"], 10) * 1000;
const _TIMEOUT = 600_000;

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
		throw new Error(`Missing data: ${path}\nRun: npm run test:mab:get`);
	const content = readFileSync(path, "utf8");
	return content
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function chunkContext(context, size) {
	const chunks = [];
	let start = 0;
	while (start < context.length) {
		const end = start + size;
		if (end >= context.length) {
			chunks.push(context.slice(start));
			break;
		}
		const boundary = context.lastIndexOf("\n", end);
		const cutAt = boundary > start ? boundary + 1 : end;
		chunks.push(context.slice(start, cutAt));
		start = cutAt;
	}
	return chunks;
}

async function askWithRetry(client, params, label = "ask") {
	const RETRY_INTERVAL_MS = 30_000;
	let attempts = 0;
	while (true) {
		// AuditClient.ask drives a `set run://` with mode=ask under the hood;
		// the legacy `client.call("ask", ...)` RPC method was removed.
		const r = await client.ask(params);
		if (r.status < 500) return r;
		attempts++;
		console.error(
			`    ⚠ ${label} got status ${r.status} (${r.error || "unknown"}). Model unreachable — pausing ${RETRY_INTERVAL_MS / 1000}s (attempt ${attempts}).`,
		);
		await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
	}
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

async function ingestContext(client, model, run, chunks, contextLimit) {
	for (let i = 0; i < chunks.length; i++) {
		const chunkNum = i + 1;
		const total = chunks.length;
		const prompt = `Read and remember what follows.\n\n${chunks[i]}`;

		let r = await askWithRetry(
			client,
			{
				model,
				prompt,
				...(run ? { run } : {}),
				noRepo: true,
				noInteraction: true,
				noProposals: true,
				noWeb: true,
				...(contextLimit ? { contextLimit } : {}),
			},
			`chunk ${chunkNum}/${total}`,
		);
		if (!run) run = r.run;
		if (r.status === 202) r = await resolveAll(client, r);
		if (r.status === 413) {
			console.error(`    chunk ${chunkNum}/${total} REJECTED: context full`);
			break;
		}
		process.stdout.write(`    ingesting ${chunkNum}/${total}\r`);
	}
	console.log(`    ingested ${chunks.length} chunks                `);
	return run;
}

async function askQuestion(client, db, model, run, question) {
	// Snapshot turn count before asking
	const preRun = await db.get_run_by_alias.get({ alias: run });
	const turnBefore = preRun.next_turn;

	let r = await askWithRetry(
		client,
		{
			model,
			prompt: question,
			run,
			noRepo: true,
			noInteraction: true,
			noProposals: true,
			noWeb: true,
		},
		"question",
	);
	if (r.status === 202) r = await resolveAll(client, r);

	if (r.status === 413)
		throw new Error("Context overflow — panic failed. Benchmark aborted.");

	// Extract answer from entries created after turnBefore
	const runRow = await db.get_run_by_alias.get({ alias: r.run });
	const entries = await db.get_known_entries.all({ run_id: runRow.id });
	const newEntries = entries.filter((e) => e.turn >= turnBefore);

	// 1. Terminal update (status=200) from the question's turns
	const summary = newEntries.find(
		(e) =>
			e.scheme === "update" && JSON.parse(e.attributes || "{}").status === 200,
	);
	if (summary?.body) return summary.body;

	// 2. Raw assistant response — strip XML tags for evaluation
	const assistant = newEntries
		.filter((e) => e.scheme === "assistant")
		.toSorted((a, b) => b.turn - a.turn)[0];
	if (assistant?.body) return assistant.body.replace(/<[^>]+>/g, " ").trim();

	// 3. Content (unparsed text)
	const content = newEntries.find((e) => e.scheme === "content");
	if (content?.body) return content.body;

	return "";
}

// Path is positional if it ends in digits, or contains part/chunk/list/batch + digit.
const POSITIONAL_PATH =
	/\/(part|chunk|batch|list|item|block)\d*$|\/-?\d+(-\d+)?$|\/\d/i;
const LONG_PATH = 80;

function checkTaxonomy(entries) {
	return entries.map((e) => {
		const attrs =
			typeof e.attributes === "string"
				? JSON.parse(e.attributes || "{}")
				: (e.attributes ?? {});
		const summary = attrs?.summary || "";

		const pathLong = e.path.length > LONG_PATH;
		const pathPositional = POSITIONAL_PATH.test(e.path);
		const pathPass = !pathLong && !pathPositional;
		const pathReason = pathLong
			? "content in path"
			: pathPositional
				? "positional"
				: null;

		const summaryPass =
			!!summary && summary.includes(",") && summary.length <= 80;
		const summaryReason = !summary
			? "missing"
			: !summary.includes(",")
				? "prose"
				: summary.length > 80
					? "too long"
					: null;

		return {
			path: e.path,
			summary,
			pathPass,
			pathReason,
			summaryPass,
			summaryReason,
		};
	});
}

function printTaxonomyReport(run, results) {
	const W = 50;
	console.log(`\nTaxonomy — ${run} (${results.length} known entries)`);
	console.log("─".repeat(W));
	for (const r of results) {
		const pm = r.pathPass ? "✓" : "✗";
		const sm = r.summaryPass ? "✓" : "✗";
		const shortPath = r.path.length > 36 ? `${r.path.slice(0, 33)}…` : r.path;
		const shortSum = r.summary
			? `"${r.summary.slice(0, 28)}${r.summary.length > 28 ? "…" : ""}"`
			: "(none)";
		const note = [r.pathReason, r.summaryReason].filter(Boolean).join(", ");
		console.log(
			`  path ${pm}  sum ${sm}  ${shortPath.padEnd(36)}  ${shortSum}${note ? `  ← ${note}` : ""}`,
		);
	}
	const pathScore = results.filter((r) => r.pathPass).length;
	const sumScore = results.filter((r) => r.summaryPass).length;
	const n = results.length;
	console.log(
		`\n  Paths: ${pathScore}/${n} semantic    Summaries: ${sumScore}/${n} keyword-format`,
	);
	return pathScore === n && sumScore === n;
}

async function runRow(client, db, model, split, rowIndex, row) {
	const source = row.metadata?.source || "unknown";
	console.log(
		`\n  [${split}:${rowIndex}] source=${source} context=${row.context.length} chars, ${row.questions.length} questions`,
	);

	const startTime = Date.now();

	// Create a fresh run — first ingestion chunk creates it
	const splitAbbrev = split.replace(/_/g, "").slice(0, 4).toLowerCase();
	let run = null;

	// Rename to a descriptive alias for easy DB inspection
	const mabAlias = `mab_${splitAbbrev}_${rowIndex}`;
	try {
		await client.call("run/rename", { run, name: mabAlias });
		run = mabAlias;
	} catch {}

	// Ingest context in chunks — first chunk creates the run
	const chunks = chunkContext(row.context, CHUNK_SIZE);
	run = await ingestContext(client, model, run, chunks, CONTEXT_LIMIT);
	if (!run) throw new Error("Ingestion failed to create run");

	// Taxonomy-only mode: check filing quality and stop before questions.
	if (TAXONOMY_ONLY) {
		const runRow2 = await db.get_run_by_alias.get({ alias: run });
		const allEntries = await db.get_known_entries.all({ run_id: runRow2.id });
		const knownEntries = allEntries.filter((e) => e.scheme === "known");
		const results = checkTaxonomy(knownEntries);
		const pass = printTaxonomyReport(run, results);
		return { split, rowIndex, source, taxonomyPass: pass, entries: results };
	}

	// Ask each question
	const questionResults = [];
	for (let qi = 0; qi < row.questions.length; qi++) {
		const question = row.questions[qi];
		const validAnswers = row.answers[qi] || [];

		const response = await askQuestion(client, db, model, run, question);
		const { pass, matched } = evaluate(response, validAnswers);
		questionResults.push({
			question,
			response,
			answers: validAnswers,
			pass,
			matched,
		});

		const mark = pass ? "✓" : "✗";
		process.stdout.write(`    ${mark} ${qi + 1}/${row.questions.length}\r`);
	}

	const endTime = Date.now();
	const score = scoreRow(questionResults);

	// Gather usage from the run
	const runRow2 = await db.get_run_by_alias.get({ alias: run });
	const usage = await db.get_run_usage.get({ run_id: runRow2.id });

	console.log(
		`    ${score.passed}/${score.total} correct (${(score.accuracy * 100).toFixed(1)}%) — ${((endTime - startTime) / 1000).toFixed(0)}s`,
	);

	return {
		split,
		rowIndex,
		source,
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

	const splits = args.split ? [args.split] : ALL_SPLITS;
	const rowRange = parseRowRange(args.row);

	console.log(
		`MemoryAgentBench Runner${TAXONOMY_ONLY ? " [taxonomy check]" : ""}`,
	);
	console.log(`Model: ${MODEL}`);
	console.log(`Chunk size: ${CHUNK_SIZE} chars`);
	console.log(`Splits: ${splits.join(", ")}`);
	if (rowRange) console.log(`Rows: ${rowRange.start}-${rowRange.end}`);

	// Verify data exists
	for (const split of splits) {
		const path = join(DATA_DIR, `${split}.ndjson`);
		if (!existsSync(path)) {
			console.error(`Missing: ${path}\nRun: npm run test:mab:get`);
			process.exit(1);
		}
	}

	// Start test infrastructure
	await fs.mkdir(RESULTS_DIR, { recursive: true });
	await fs.mkdir("/tmp/rummy-mab", { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runDir = join(RESULTS_DIR, timestamp);
	await fs.mkdir(runDir, { recursive: true });

	// Point RUMMY_HOME at the results dir so last_run.txt lands there
	process.env.RUMMY_HOME = runDir;

	// DB lives in the results directory from the start — survives kills.
	const dbPath = join(runDir, "mab.db");
	const tdb = await TestDb.createAt(dbPath, "mab");
	const tserver = await TestServer.start(tdb);
	const client = new AuditClient(tserver.url, tdb.db);
	await client.connect();
	await client.call("rummy/hello", {
		name: "MAB",
		projectRoot: "/tmp/rummy-mab",
	});

	console.log(`Database: ${dbPath}`);

	const allResults = [];
	const resultsPath = join(runDir, "results.ndjson");

	try {
		for (const split of splits) {
			console.log(`\n${"═".repeat(58)}`);
			console.log(`Split: ${split}`);
			console.log(`${"═".repeat(58)}`);

			const rows = loadSplit(split);
			const start = rowRange?.start ?? 0;
			const end = Math.min(rowRange?.end ?? rows.length - 1, rows.length - 1);

			for (let i = start; i <= end; i++) {
				const result = await runRow(client, tdb.db, MODEL, split, i, rows[i]);
				allResults.push(result);

				// Append incrementally so partial results survive crashes
				await fs.appendFile(resultsPath, `${JSON.stringify(result)}\n`);

				if (ROW_DELAY_MS > 0 && i < end) {
					await new Promise((resolve) => setTimeout(resolve, ROW_DELAY_MS));
				}
			}
		}
	} finally {
		await client?.close();
		await tserver?.stop();
		await tdb.cleanup();
	}

	if (!TAXONOMY_ONLY) printReport(allResults);
	console.log(`\nResults:  ${resultsPath}`);
	console.log(`Database: ${join(runDir, "mab.db")}`);
	console.log(`Run log:  ${join(runDir, "last_run.txt")}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
