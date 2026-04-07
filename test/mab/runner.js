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

async function ingestContext(client, model, run, chunks) {
	for (let i = 0; i < chunks.length; i++) {
		const chunkNum = i + 1;
		const total = chunks.length;
		const prompt = [
			`Memory ingestion — chunk ${chunkNum} of ${total}.`,
			"Read and remember the key facts in this text.",
			"Use <known> to save important information.",
			"Use <update> when done (do NOT use <summarize>).",
			"",
			chunks[i],
		].join("\n");

		const r = await client.call("ask", { model, prompt, run, noContext: true });
		if (r.status >= 500) {
			console.warn(
				`    chunk ${chunkNum}/${total} failed: ${r.error || "unknown"}`,
			);
		}
		process.stdout.write(`    ingesting ${chunkNum}/${total}\r`);
	}
	console.log(`    ingested ${chunks.length} chunks                `);
}

async function askQuestion(client, db, model, run, question) {
	const prompt = [
		"Answer the following question based on what you remember.",
		"Reply with ONLY the answer, as briefly as possible.",
		"",
		question,
	].join("\n");

	const r = await client.call("ask", { model, prompt, run });

	if (r.status >= 500) return "";

	const runRow = await db.get_run_by_alias.get({ alias: r.run });
	const summary = await db.get_latest_summary.get({
		run_id: runRow.id,
		loop_id: null,
	});
	if (summary?.body) return summary.body;

	const entries = await db.get_known_entries.all({ run_id: runRow.id });
	const content = entries
		.filter((e) => e.scheme === "content")
		.toSorted((a, b) => b.turn - a.turn);
	return content[0]?.body || "";
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
			"You are being evaluated on memory and retrieval. Incoming context chunks follow. Use <known> to save facts. Reply with <update>ready</update>.",
		noContext: true,
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

	const tdb = await TestDb.create("mab");
	const tserver = await TestServer.start(tdb.db);
	const client = new AuditClient(tserver.url, tdb.db);
	await client.connect();
	await client.call("init", { name: "MAB", projectRoot: "/tmp/rummy-mab" });

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

		// Preserve the database in the results directory
		const dbDest = join(runDir, "mab.db");
		await fs.copyFile(tdb.dbPath, dbDest).catch(() => {});
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
