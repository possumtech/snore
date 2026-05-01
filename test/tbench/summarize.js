/**
 * tbench sweep summarizer. Reads a result-dir produced by runner.js and
 * emits a brag-ready summary: wall time, pass/fail counts, total cost,
 * total tokens, peak RAM, OOM count, per-task table.
 *
 * Usage:
 *   node test/tbench/summarize.js test/tbench/results/<sweep-dir>
 *   node test/tbench/summarize.js                                    # latest sweep
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

function parseCsv(text) {
	const lines = text.trim().split("\n");
	if (lines.length < 2) return { header: [], rows: [] };
	const header = lines[0].split(",");
	const rows = lines.slice(1).map((line) => {
		const cells = line.split(",");
		return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
	});
	return { header, rows };
}

function findTrialDirs(sweepDir) {
	const trials = [];
	function walk(dir) {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (!statSync(full).isDirectory()) continue;
			// A trial dir contains agent/rummy.txt
			try {
				if (statSync(join(full, "agent", "rummy.txt")).isFile()) {
					trials.push(full);
					continue;
				}
			} catch {}
			walk(full);
		}
	}
	walk(sweepDir);
	return trials;
}

function readRunSummary(rummyTxt) {
	const text = readFileSync(rummyTxt, "utf8");
	const m = text.match(/__RUMMY_RUN_SUMMARY__\s+(\{.*\})\s*$/m);
	if (!m) return null;
	try {
		return JSON.parse(m[1]);
	} catch {
		return null;
	}
}

function readReward(trialDir) {
	try {
		return Number(
			readFileSync(join(trialDir, "verifier", "reward.txt"), "utf8").trim(),
		);
	} catch {
		return null;
	}
}

function trialName(trialDir) {
	const parts = trialDir.split("/");
	const last = parts[parts.length - 1];
	return last.replace(/__[A-Za-z0-9]+$/, "");
}

const targetDir =
	process.argv[2] ??
	readdirSync(RESULTS_DIR)
		.filter((d) => statSync(join(RESULTS_DIR, d)).isDirectory())
		.sort()
		.pop();
if (!targetDir) {
	console.error("no sweep dir found");
	process.exit(2);
}
const sweepDir = targetDir.startsWith("/")
	? targetDir
	: join(RESULTS_DIR, targetDir);

let sweepInfo = null;
try {
	sweepInfo = JSON.parse(
		readFileSync(join(sweepDir, "sweep_summary.json"), "utf8"),
	);
} catch {}

const trials = findTrialDirs(sweepDir);
const rows = [];
let totalCost = 0;
let totalPromptTokens = 0;
let totalCompletionTokens = 0;
let totalCachedTokens = 0;
let totalReasoningTokens = 0;
const statusCounts = new Map();
let passCount = 0;
let failCount = 0;
let exfilFailCount = 0;

for (const t of trials) {
	const summary = readRunSummary(join(t, "agent", "rummy.txt"));
	const reward = readReward(t);
	const name = trialName(t);
	const status = summary?.status ?? null;
	const turns = summary?.turns ?? null;
	const cost = summary?.cost ?? 0;
	const tokens = summary?.tokens ?? {};

	if (!summary) exfilFailCount++;
	if (reward === 1) passCount++;
	else if (reward === 0) failCount++;
	if (status != null) {
		statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
	}

	totalCost += cost;
	totalPromptTokens += tokens.prompt ?? 0;
	totalCompletionTokens += tokens.completion ?? 0;
	totalCachedTokens += tokens.cached ?? 0;
	totalReasoningTokens += tokens.reasoning ?? 0;

	rows.push({ name, reward, status, turns, cost });
}

// Sysmon analysis: peak RAM, peak swap, peak concurrent containers, OOM count.
let peakMemUsedMb = null;
let minMemAvailMb = null;
let peakSwapUsedMb = null;
let peakNContainers = null;
let peakLoad1 = null;
try {
	const sysmon = parseCsv(readFileSync(join(sweepDir, "sysmon.csv"), "utf8"));
	for (const r of sysmon.rows) {
		const memUsed = Number(r.mem_used_mb);
		const memAvail = Number(r.mem_avail_mb);
		const swapUsed = Number(r.swap_used_mb);
		const nCont = Number(r.n_containers);
		const load1 = Number(r.load_1m);
		if (
			Number.isFinite(memUsed) &&
			(peakMemUsedMb == null || memUsed > peakMemUsedMb)
		)
			peakMemUsedMb = memUsed;
		if (
			Number.isFinite(memAvail) &&
			(minMemAvailMb == null || memAvail < minMemAvailMb)
		)
			minMemAvailMb = memAvail;
		if (
			Number.isFinite(swapUsed) &&
			(peakSwapUsedMb == null || swapUsed > peakSwapUsedMb)
		)
			peakSwapUsedMb = swapUsed;
		if (
			Number.isFinite(nCont) &&
			(peakNContainers == null || nCont > peakNContainers)
		)
			peakNContainers = nCont;
		if (Number.isFinite(load1) && (peakLoad1 == null || load1 > peakLoad1))
			peakLoad1 = load1;
	}
} catch {}

let oomCount = 0;
let oomList = [];
try {
	const lines = readFileSync(join(sweepDir, "oom.log"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean);
	oomCount = lines.length;
	oomList = lines;
} catch {}

let peakContainerMemMb = null;
const perContainerPeak = new Map();
try {
	const cont = parseCsv(readFileSync(join(sweepDir, "containers.csv"), "utf8"));
	for (const r of cont.rows) {
		const mem = Number(r.mem_mb);
		if (!Number.isFinite(mem)) continue;
		if (peakContainerMemMb == null || mem > peakContainerMemMb)
			peakContainerMemMb = mem;
		const prev = perContainerPeak.get(r.container_name) ?? 0;
		if (mem > prev) perContainerPeak.set(r.container_name, mem);
	}
} catch {}

// Print summary.
console.log("# Sweep summary");
console.log(`Path:        ${sweepDir}`);
if (sweepInfo) {
	console.log(`Started:     ${sweepInfo.startedAt}`);
	console.log(`Ended:       ${sweepInfo.endedAt}`);
	console.log(
		`Wall time:   ${sweepInfo.wallHuman} (${sweepInfo.wallSeconds}s)`,
	);
	console.log(`Concurrency: ${sweepInfo.concurrency}`);
	console.log(`Model:       ${sweepInfo.model}`);
	console.log(`Dataset:     ${sweepInfo.dataset}`);
	console.log(`Agent:       ${sweepInfo.agent}`);
	console.log(`Harbor exit: ${sweepInfo.harborExit}`);
}
console.log("");
console.log("# Outcomes");
console.log(`Trials:      ${trials.length}`);
console.log(`Pass:        ${passCount}`);
console.log(`Fail:        ${failCount}`);
console.log(
	`Score:       ${(passCount / Math.max(1, trials.length)).toFixed(3)}`,
);
console.log(`Exfil fail:  ${exfilFailCount}`);
console.log("");
console.log("# Run terminal status counts");
for (const [status, count] of [...statusCounts.entries()].sort(
	(a, b) => a[0] - b[0],
)) {
	console.log(`  ${status}: ${count}`);
}
console.log("");
console.log("# Cost + tokens (sum across all trials)");
console.log(`Cost:        $${totalCost.toFixed(4)}`);
console.log(`Prompt tokens:     ${totalPromptTokens.toLocaleString()}`);
console.log(`Cached tokens:     ${totalCachedTokens.toLocaleString()}`);
console.log(`Completion tokens: ${totalCompletionTokens.toLocaleString()}`);
console.log(`Reasoning tokens:  ${totalReasoningTokens.toLocaleString()}`);
console.log("");
console.log("# Resource peaks (sysmon)");
if (peakMemUsedMb != null) {
	console.log(`Peak host mem used:   ${peakMemUsedMb} MiB`);
	console.log(`Min host mem avail:   ${minMemAvailMb} MiB`);
	console.log(`Peak swap used:       ${peakSwapUsedMb} MiB`);
	console.log(`Peak load_1m:         ${peakLoad1}`);
	console.log(`Peak concurrent ctnr: ${peakNContainers}`);
} else {
	console.log("(no sysmon data — single-task run, or sysmon disabled)");
}
if (peakContainerMemMb != null) {
	console.log(`Peak per-task mem:    ${peakContainerMemMb} MiB`);
}
console.log(`OOM kills:           ${oomCount}`);
for (const oom of oomList) console.log(`  ! ${oom}`);
console.log("");
console.log("# Per-task results");
for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
	const reward = r.reward == null ? "  ?" : r.reward === 1 ? "PASS" : "FAIL";
	const status = r.status ?? "—";
	const turns = r.turns ?? "—";
	console.log(`  ${reward}  status=${status}  turns=${turns}  ${r.name}`);
}
