#!/usr/bin/env node
/**
 * Walk test/tbench/results/, join each run's __RUMMY_RUN_SUMMARY__ line
 * with verifier reward and harbor result.json, print a comparison table.
 *
 * Usage:
 *   node test/tbench/report.js                    # all runs, all tasks
 *   node test/tbench/report.js --task regex-log   # filter by task
 *   node test/tbench/report.js --last 5           # last N runs
 *   node test/tbench/report.js --csv              # comma-separated for export
 */
import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

const { values: args } = parseArgs({
	options: {
		task: { type: "string" },
		last: { type: "string" },
		csv: { type: "boolean" },
	},
	strict: true,
});

const SUMMARY_MARKER = "__RUMMY_RUN_SUMMARY__ ";

async function isDir(p) {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

function tryRead(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function tryReadJson(path) {
	const text = tryRead(path);
	if (text == null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function extractSummary(rummyTxt) {
	if (!rummyTxt) return null;
	const lines = rummyTxt.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].startsWith(SUMMARY_MARKER)) {
			try {
				return JSON.parse(lines[i].slice(SUMMARY_MARKER.length));
			} catch {
				return null;
			}
		}
	}
	return null;
}

async function gatherRuns() {
	const runs = [];
	const topDirs = (await readdir(RESULTS_DIR)).filter((n) =>
		/^\d{4}-\d{2}-\d{2}T/.test(n),
	);
	for (const top of topDirs.sort()) {
		const topPath = join(RESULTS_DIR, top);
		if (!(await isDir(topPath))) continue;

		const stamps = await readdir(topPath);
		for (const stamp of stamps) {
			const stampPath = join(topPath, stamp);
			if (!(await isDir(stampPath))) continue;

			const trials = await readdir(stampPath);
			for (const trial of trials) {
				const trialPath = join(stampPath, trial);
				if (!(await isDir(trialPath))) continue;

				const result = tryReadJson(join(trialPath, "result.json"));
				if (!result) continue;
				const reward = Number(
					tryRead(join(trialPath, "verifier", "reward.txt"))?.trim() ?? "",
				);
				const summary = extractSummary(
					tryRead(join(trialPath, "agent", "rummy.txt")),
				);
				const exitCode = Number(
					tryRead(join(trialPath, "agent", "rummy_exit_code"))?.trim() ?? "",
				);

				runs.push({
					timestamp: top,
					task: result.task_name,
					trial: trial,
					reward: Number.isFinite(reward) ? reward : null,
					exitCode: Number.isFinite(exitCode) ? exitCode : null,
					summary,
				});
			}
		}
	}
	return runs;
}

function formatRow(r) {
	const s = r.summary;
	const cachePct =
		s?.tokens?.prompt > 0
			? ((s.tokens.cached / s.tokens.prompt) * 100).toFixed(0)
			: "—";
	return {
		when: r.timestamp.slice(0, 19).replace("T", " "),
		task: r.task,
		reward: r.reward === null ? "—" : r.reward.toFixed(1),
		status: s?.status ?? "—",
		turns: s?.turns ?? "—",
		cost: s?.cost == null ? "—" : `$${s.cost.toFixed(4)}`,
		prompt: s?.tokens?.prompt ?? "—",
		cached: s?.tokens?.cached ?? "—",
		cachePct: `${cachePct}%`,
		out: s?.tokens?.completion ?? "—",
		reason: s?.tokens?.reasoning ?? "—",
		model: s?.model ?? "—",
	};
}

function printTable(rows) {
	if (rows.length === 0) {
		console.log("No runs found.");
		return;
	}
	const cols = [
		["when", 19],
		["task", 18],
		["reward", 6],
		["status", 6],
		["turns", 5],
		["cost", 9],
		["prompt", 7],
		["cached", 7],
		["cachePct", 7],
		["out", 7],
		["reason", 7],
		["model", 8],
	];
	const header = cols.map(([key, w]) => String(key).padEnd(w)).join("  ");
	console.log(header);
	console.log("─".repeat(header.length));
	for (const r of rows) {
		console.log(
			cols.map(([key, w]) => String(r[key] ?? "—").padEnd(w)).join("  "),
		);
	}
}

function printCsv(rows) {
	if (rows.length === 0) return;
	const keys = Object.keys(rows[0]);
	console.log(keys.join(","));
	for (const r of rows) {
		console.log(keys.map((k) => JSON.stringify(r[k] ?? "")).join(","));
	}
}

const runs = (await gatherRuns()).sort((a, b) =>
	a.timestamp.localeCompare(b.timestamp),
);

let filtered = runs;
if (args.task) filtered = filtered.filter((r) => r.task === args.task);
if (args.last) {
	const n = Number.parseInt(args.last, 10);
	if (Number.isInteger(n) && n > 0) filtered = filtered.slice(-n);
}

const rows = filtered.map(formatRow);
if (args.csv) printCsv(rows);
else printTable(rows);

// Aggregates (only when not CSV).
if (!args.csv && rows.length > 1) {
	const passed = filtered.filter((r) => r.reward === 1).length;
	const total = filtered.length;
	const totalCost = filtered.reduce(
		(acc, r) => acc + (r.summary?.cost ?? 0),
		0,
	);
	const totalTokens = filtered.reduce(
		(acc, r) => acc + (r.summary?.tokens?.total ?? 0),
		0,
	);
	console.log("");
	console.log(
		`pass rate: ${passed}/${total} (${((passed / total) * 100).toFixed(0)}%)  ` +
			`total cost: $${totalCost.toFixed(4)}  ` +
			`total tokens: ${totalTokens}`,
	);
}
