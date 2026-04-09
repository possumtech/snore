/**
 * MemoryAgentBench runner for Rummy.
 *
 * Runs live agent sessions against the MAB dataset.
 * Each benchmark row: create a run, feed context chunks
 * via ask prompts, then quiz the agent on each question.
 *
 * Usage:
 *   node test/mab/runner.js                           # all splits
 *   node test/mab/runner.js --split Accurate_Retrieval # one split
 *   node test/mab/runner.js --split Accurate_Retrieval --row 0  # one row
 *   node test/mab/runner.js --row 0-4                  # row range
 *   node test/mab/runner.js --chunk-size 4000          # chars per chunk
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
	},
	strict: false,
});

const CHUNK_SIZE = Number.parseInt(args["chunk-size"], 10);
const MODEL = args.model || process.env.RUMMY_TEST_MODEL;
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
	for (let i = 0; i < context.length; i += size) {
		chunks.push(context.slice(i, i + size));
	}
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

async function ingestContext(client, model, run, chunks) {
	for (let i = 0; i < chunks.length; i++) {
		const chunkNum = i + 1;
		const total = chunks.length;
		const prompt = [
			`Memory ingestion — chunk ${chunkNum} of ${total}.`,
			"Read and remember the key facts in this text.",
			"",
			chunks[i],
		].join("\n");

		let r = await client.call("ask", {
			model,
			prompt,
			run,
			noRepo: true,
			noInteraction: true,
			noWeb: true,
		});
		if (r.status === 202) r = await resolveAll(client, r);
		if (r.status === 413) {
			console.error(`    chunk ${chunkNum}/${total} REJECTED: context full`);
			break;
		}
		if (r.status >= 500) {
			console.error(
				`    chunk ${chunkNum}/${total} FAILED: ${r.error || "unknown"}`,
			);
			break;
		}
		process.stdout.write(`    ingesting ${chunkNum}/${total}\r`);
	}
	console.log(`    ingested ${chunks.length} chunks                `);
}

async function askQuestion(client, db, model, run, question) {
	// Snapshot turn count before asking
	const preRun = await db.get_run_by_alias.get({ alias: run });
	const turnBefore = preRun.next_turn;

	let r = await client.call("ask", {
		model,
		prompt: question,
		run,
		noInteraction: true,
		noWeb: true,
	});
	if (r.status === 202) r = await resolveAll(client, r);

	if (r.status >= 500) return "";

	// Extract answer from entries created after turnBefore
	const runRow = await db.get_run_by_alias.get({ alias: r.run });
	const entries = await db.get_known_entries.all({ run_id: runRow.id });
	const newEntries = entries.filter((e) => e.turn >= turnBefore);

	// 1. Summarize entry from the question's turns
	const summary = newEntries.find((e) => e.scheme === "summarize");
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

async function runRow(client, db, model, split, rowIndex, row) {
	const source = row.metadata?.source || "unknown";
	console.log(
		`\n  [${split}:${rowIndex}] source=${source} context=${row.context.length} chars, ${row.questions.length} questions`,
	);

	const startTime = Date.now();

	// Create a fresh run for this benchmark row
	const splitAbbrev = split.replace(/_/g, "").slice(0, 4).toLowerCase();
	const initR = await client.call("ask", {
		model,
		prompt:
			"You are being evaluated on memory and retrieval. Incoming context chunks follow. Use <known> to save every fact. Reply with <summarize>ready</summarize>.",
		noRepo: true,
	});
	let run = initR.run;

	// Rename to a descriptive alias for easy DB inspection
	const mabAlias = `mab_${splitAbbrev}_${rowIndex}`;
	try {
		await client.call("run/rename", { run, name: mabAlias });
		run = mabAlias;
	} catch {}

	// Ingest context in chunks
	const chunks = chunkContext(row.context, CHUNK_SIZE);
	await ingestContext(client, model, run, chunks);

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

	console.log(`MemoryAgentBench Runner`);
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
	const tserver = await TestServer.start(tdb.db);
	const client = new AuditClient(tserver.url, tdb.db);
	await client.connect();
	await client.call("init", { name: "MAB", projectRoot: "/tmp/rummy-mab" });

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
			}
		}
	} finally {
		await client?.close();
		await tserver?.stop();
		await tdb.cleanup();
	}

	// Print report
	printReport(allResults);
	console.log(`\nResults:  ${resultsPath}`);
	console.log(`Database: ${join(runDir, "mab.db")}`);
	console.log(`Run log:  ${join(runDir, "last_run.txt")}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
