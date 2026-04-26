/**
 * MAB single-question auditor.
 *
 * Runs one question at a time against a pre-ingested run,
 * captures full diagnostics, and appends to MAB.md.
 *
 * Usage:
 *   node test/mab/audit.js                    # ingest + all questions
 *   node test/mab/audit.js --question 0       # single question (after ingest)
 *   node test/mab/audit.js --question 0-4     # range
 *   node test/mab/audit.js --ingest-only      # just ingest, no questions
 */
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";
import { evaluate } from "./evaluate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

const { values: args } = parseArgs({
	options: {
		split: { type: "string", default: "Conflict_Resolution" },
		row: { type: "string", default: "0" },
		question: { type: "string" },
		"chunk-size": { type: "string", default: "4000" },
		"ingest-only": { type: "boolean", default: false },
		model: { type: "string" },
	},
	strict: false,
});

const CHUNK_SIZE = Number.parseInt(args["chunk-size"], 10);
const MODEL = args.model || process.env.RUMMY_TEST_MODEL;
const SPLIT = args.split;
const ROW_IDX = Number.parseInt(args.row, 10);

function parseRange(spec) {
	if (!spec) return null;
	if (spec.includes("-")) {
		const [start, end] = spec.split("-").map(Number);
		return { start, end };
	}
	const n = Number(spec);
	return { start: n, end: n };
}

function loadRow(split, idx) {
	const path = join(DATA_DIR, `${split}.ndjson`);
	if (!existsSync(path))
		throw new Error(`Missing: ${path}\nRun: npm run test:mab:get`);
	const lines = readFileSync(path, "utf8").trim().split("\n");
	return JSON.parse(lines[idx]);
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
			current = await client.resolveProposal(current.run, {
				path: p.path,
				action: "accept",
				output: p.path?.startsWith("ask_user://") ? "N/A" : "",
			});
			resolves++;
		}
	}
	return current;
}

async function ingest(client, db, model, run, chunks) {
	for (let i = 0; i < chunks.length; i++) {
		const prompt = [
			`Memory ingestion — chunk ${i + 1} of ${chunks.length}.`,
			"Read and remember the key facts in this text.",
			"",
			chunks[i],
		].join("\n");
		let r = await client.ask({
			model,
			prompt,
			run,
			noRepo: true,
			noInteraction: true,
			noWeb: true,
		});
		if (r.status === 202) r = await resolveAll(client, r);
		console.log(`  ingested chunk ${i + 1}/${chunks.length}`);
	}

	// Report what was saved
	const entries = await db.get_known_entries.all({
		run_id: await runId(db, run),
	});
	const knowns = entries.filter((e) => e.scheme === "known");
	console.log(`  ${knowns.length} known entries saved`);
}

async function runId(db, alias) {
	const row = await db.get_run_by_alias.get({ alias });
	return row.id;
}

async function auditQuestion(
	client,
	db,
	model,
	run,
	qi,
	question,
	validAnswers,
	_contextLines,
) {
	const rid = await runId(db, run);

	// Snapshot: what known entries are visible before asking?
	const preEntries = await db.get_known_entries.all({ run_id: rid });
	const preKnowns = preEntries
		.filter((e) => e.scheme === "known" && e.visibility === "visible")
		.map((e) => ({ path: e.path, body: e.body?.slice(0, 200) }));
	const preKnownCount = preKnowns.length;
	const storedCount = preEntries.filter(
		(e) => e.visibility === "archived",
	).length;
	const indexCount = preEntries.filter((e) => e.visibility === "index").length;
	const summaryCount = preEntries.filter(
		(e) => e.visibility === "summarized",
	).length;

	// Ask the question
	const preRun = await db.get_run_by_alias.get({ alias: run });
	const turnBefore = preRun.next_turn;

	const prompt = question;

	let r = await client.ask({
		model,
		prompt,
		run,
		noInteraction: true,
		noWeb: true,
	});
	if (r.status === 202) r = await resolveAll(client, r);

	// Get entries from this question's turns
	const postEntries = await db.get_known_entries.all({ run_id: rid });
	const newEntries = postEntries.filter((e) => e.turn >= turnBefore);

	// Extract response
	const summaryEntry = newEntries.find(
		(e) =>
			e.scheme === "update" && JSON.parse(e.attributes || "{}").status === 200,
	);
	const assistantEntries = newEntries
		.filter((e) => e.scheme === "assistant")
		.toSorted((a, b) => b.turn - a.turn);
	const reasoningEntries = newEntries
		.filter((e) => e.scheme === "reasoning")
		.toSorted((a, b) => b.turn - a.turn);

	const response =
		summaryEntry?.body ||
		assistantEntries[0]?.body?.replace(/<[^>]+>/g, " ").trim() ||
		"";
	const reasoning = reasoningEntries[0]?.body || "";
	const rawAssistant = assistantEntries[0]?.body || "";

	const { pass, matched } = evaluate(response, validAnswers);

	// Find relevant facts in context for the chain
	const uniqueAnswers = [...new Set(validAnswers)];

	// Build diagnostic
	const diagnostic = {
		qi,
		question,
		expected: uniqueAnswers,
		got: response,
		pass,
		matched,
		reasoning: reasoning.slice(0, 2000),
		rawAssistant: rawAssistant.slice(0, 500),
		context: {
			knownsFull: preKnownCount,
			knownsSummary: summaryCount,
			knownsIndex: indexCount,
			knownsStored: storedCount,
		},
		turnsBefore: turnBefore,
		turnsAfter: (await db.get_run_by_alias.get({ alias: run })).next_turn,
		status: r.status,
	};

	return diagnostic;
}

function formatDiagnostic(d, _contextLines) {
	const status = d.pass ? "PASS" : "FAIL";
	const lines = [];
	lines.push(`### Q${d.qi + 1}: ${d.question}`);
	lines.push(`**Status:** ${status}`);
	lines.push(`**Expected:** ${d.expected.join(" / ")}`);
	lines.push(`**Got:** ${d.got || "(empty)"}`);
	lines.push(`**Turns used:** ${d.turnsAfter - d.turnsBefore}`);
	lines.push(
		`**Context at question time:** ${d.context.knownsFull} full, ${d.context.knownsSummary} summary, ${d.context.knownsIndex} index, ${d.context.knownsStored} stored`,
	);
	lines.push("");

	if (!d.pass) {
		if (d.reasoning) {
			lines.push("**Model reasoning:**");
			lines.push("```");
			lines.push(d.reasoning.slice(0, 1500));
			lines.push("```");
			lines.push("");
		}
		if (d.rawAssistant && !d.reasoning) {
			lines.push("**Model response:**");
			lines.push("```");
			lines.push(d.rawAssistant.slice(0, 500));
			lines.push("```");
			lines.push("");
		}
		lines.push("**Diagnosis:** TODO — manual review required");
		lines.push("");
		lines.push("**Recommendation:** TODO");
	}
	lines.push("");
	return lines.join("\n");
}

async function main() {
	if (!MODEL) {
		console.error("No model configured. Set RUMMY_TEST_MODEL in .env.test");
		process.exit(1);
	}

	const row = loadRow(SPLIT, ROW_IDX);
	const contextLines = row.context.split("\n");
	const questionRange = parseRange(args.question);

	console.log(`MAB Audit: ${SPLIT} row ${ROW_IDX}`);
	console.log(`Model: ${MODEL}`);
	console.log(
		`Context: ${row.context.length} chars, ${row.questions.length} questions`,
	);

	// Setup
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const auditDir = join(__dirname, "results", `audit_${timestamp}`);
	await fs.mkdir(auditDir, { recursive: true });
	process.env.RUMMY_HOME = auditDir;

	const dbPath = join(auditDir, "mab.db");
	const tdb = await TestDb.createAt(dbPath, "mab_audit");
	const tserver = await TestServer.start(tdb);
	const client = new AuditClient(tserver.url, tdb.db);
	await client.connect();
	await client.call("rummy/hello", {
		name: "MABAudit",
		projectRoot: "/tmp/rummy-mab-audit",
	});
	await fs.mkdir("/tmp/rummy-mab-audit", { recursive: true });

	// Create run and ingest
	const initR = await client.ask({
		model: MODEL,
		prompt:
			"You are being evaluated on memory and retrieval. Incoming context chunks follow. Use <known> to save facts. Reply with <update>ready</update>.",
		noRepo: true,
		noInteraction: true,
		noWeb: true,
	});
	const run = initR.run;

	console.log(`\nIngesting ${row.context.length} chars...`);
	const chunks = chunkContext(row.context, CHUNK_SIZE);
	await ingest(client, tdb.db, MODEL, run, chunks);

	if (args["ingest-only"]) {
		console.log(`\nIngest complete. Database: ${dbPath}`);
		await client.close();
		await tserver.stop();
		await tdb.cleanup();
		return;
	}

	// Run questions
	const start = questionRange?.start ?? 0;
	const end = Math.min(
		questionRange?.end ?? row.questions.length - 1,
		row.questions.length - 1,
	);

	const reportPath = join(auditDir, "MAB_AUDIT.md");
	const diagnostics = [];

	let header = `# MAB Audit: ${SPLIT} Row ${ROW_IDX}\n\n`;
	header += `**Model:** ${MODEL}\n`;
	header += `**Context:** ${row.context.length} chars (${chunks.length} chunks @ ${CHUNK_SIZE})\n`;
	header += `**Questions:** ${start}-${end} of ${row.questions.length}\n`;
	header += `**Date:** ${new Date().toISOString()}\n\n---\n\n`;
	await fs.writeFile(reportPath, header);

	for (let qi = start; qi <= end; qi++) {
		console.log(`\n  Q${qi + 1}: ${row.questions[qi].slice(0, 60)}...`);
		const d = await auditQuestion(
			client,
			tdb.db,
			MODEL,
			run,
			qi,
			row.questions[qi],
			row.answers[qi],
			contextLines,
		);
		diagnostics.push(d);

		const mark = d.pass ? "✓" : "✗";
		console.log(`  ${mark} ${d.got?.slice(0, 60) || "(empty)"}`);

		// Append to report incrementally
		await fs.appendFile(reportPath, `${formatDiagnostic(d, contextLines)}\n`);
	}

	// Summary
	const passed = diagnostics.filter((d) => d.pass).length;
	const total = diagnostics.length;
	const summary = `\n---\n\n## Summary\n\n**${passed}/${total}** (${((passed / total) * 100).toFixed(1)}%)\n`;
	await fs.appendFile(reportPath, summary);

	await client.close();
	await tserver.stop();
	await tdb.cleanup();

	console.log(`\nReport:   ${reportPath}`);
	console.log(`Database: ${dbDest}`);
	console.log(
		`Result:   ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
