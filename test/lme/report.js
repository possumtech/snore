/**
 * Report generator for LongMemEval results.
 *
 * Reads results from an NDJSON results file and prints
 * a formatted summary to stdout.
 */
import fs from "node:fs/promises";

/**
 * @param {{ split: string, rowIndex: number, questionType: string, score: object, usage: object, timing: object, questions: object[] }[]} results
 */
export function printReport(results) {
	if (results.length === 0) {
		console.log("No results to report.");
		return;
	}

	const types = {};
	let totalPassed = 0;
	let totalQuestions = 0;
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;
	let totalCost = 0;
	let totalDurationMs = 0;

	for (const r of results) {
		const type = r.questionType || "unknown";
		types[type] ??= { passed: 0, total: 0, rows: 0 };
		types[type].passed += r.score.passed;
		types[type].total += r.score.total;
		types[type].rows++;

		totalPassed += r.score.passed;
		totalQuestions += r.score.total;
		totalPromptTokens += r.usage?.prompt_tokens ?? 0;
		totalCompletionTokens += r.usage?.completion_tokens ?? 0;
		totalCost += r.usage?.cost ?? 0;
		totalDurationMs += r.timing?.duration_ms ?? 0;
	}

	console.log("\n╔══════════════════════════════════════════════════════════╗");
	console.log("║              LongMemEval — Results Report               ║");
	console.log("╚══════════════════════════════════════════════════════════╝\n");

	console.log("Per-Type Accuracy:");
	console.log("─".repeat(58));
	for (const [name, s] of Object.entries(types).toSorted((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		const pct = s.total > 0 ? ((s.passed / s.total) * 100).toFixed(1) : "0.0";
		const bar =
			"█".repeat(Math.round((s.passed / s.total) * 20)) +
			"░".repeat(20 - Math.round((s.passed / s.total) * 20));
		console.log(
			`  ${name.padEnd(28)} ${bar} ${pct}% (${s.passed}/${s.total}) [${s.rows} rows]`,
		);
	}

	console.log("");
	console.log("Overall:");
	console.log("─".repeat(58));
	const overallPct =
		totalQuestions > 0
			? ((totalPassed / totalQuestions) * 100).toFixed(1)
			: "0.0";
	console.log(
		`  Accuracy:    ${overallPct}% (${totalPassed}/${totalQuestions})`,
	);
	console.log(`  Rows:        ${results.length}`);
	console.log(`  Duration:    ${(totalDurationMs / 1000).toFixed(1)}s`);
	console.log("");

	console.log("Token Usage:");
	console.log("─".repeat(58));
	console.log(`  Prompt:      ${totalPromptTokens.toLocaleString()}`);
	console.log(`  Completion:  ${totalCompletionTokens.toLocaleString()}`);
	console.log(
		`  Total:       ${(totalPromptTokens + totalCompletionTokens).toLocaleString()}`,
	);
	console.log(`  Cost:        $${totalCost.toFixed(4)}`);
	console.log("");

	const failures = results.flatMap((r) =>
		r.questions
			.filter((q) => !q.pass)
			.map((q) => ({
				split: r.split,
				row: r.rowIndex,
				type: r.questionType,
				...q,
			})),
	);

	if (failures.length > 0 && failures.length <= 50) {
		console.log(`Failed Questions (${failures.length}):`);
		console.log("─".repeat(58));
		for (const f of failures.slice(0, 30)) {
			console.log(`  [${f.split}:${f.row}] (${f.type}) Q: ${f.question.slice(0, 60)}`);
			console.log(`    Expected: ${f.answers?.[0]?.slice(0, 60) ?? "?"}`);
			console.log(`    Got:      ${f.response?.slice(0, 60) ?? "(empty)"}`);
		}
		if (failures.length > 30) {
			console.log(`  ... and ${failures.length - 30} more`);
		}
	} else if (failures.length > 50) {
		console.log(`Failed Questions: ${failures.length} (too many to list)`);
	}

	console.log("");
}

/**
 * Load results from an NDJSON file.
 */
export async function loadResults(path) {
	const content = await fs.readFile(path, "utf8");
	return content
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
