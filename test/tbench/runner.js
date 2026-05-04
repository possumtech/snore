/**
 * terminal-bench 2.0 runner. Thin wrapper around `harbor run`.
 *
 * Usage:
 *   node test/tbench/runner.js                                    # full dataset sweep (all 89 tasks)
 *   node test/tbench/runner.js --task <id>                        # single task
 *   node test/tbench/runner.js --task <id> --agent codex          # alt adapter
 *
 * Reads .env.tbench (loaded by the npm script) for harbor location,
 * dataset, default model. Tees harbor output to test/tbench/results/.
 */
import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

const { values: args } = parseArgs({
	options: {
		task: { type: "string" },
		agent: { type: "string", default: "rummy" },
		model: { type: "string" },
		dataset: { type: "string" },
		// Override the per-run output directory. CLI > env > default.
		// Relative paths resolve against the project root (cwd at npm-script
		// invocation); absolute paths are used as-is. Used to land sweeps
		// in named locations like `audit/gemma_1` for parallel runs.
		out: { type: "string" },
	},
	strict: true,
});

const harborDir = process.env.RUMMY_TBENCH_HARBOR_DIR?.replace(
	/^~/,
	process.env.HOME,
);
if (!harborDir || !existsSync(harborDir)) {
	console.error(
		`Harbor checkout not found at ${harborDir}. Run: npm run test:tbench:setup`,
	);
	process.exit(2);
}

const dataset = args.dataset || process.env.RUMMY_TBENCH_DATASET;
const model = args.model || process.env.RUMMY_TBENCH_MODEL;
if (!dataset || !model) {
	console.error(
		"RUMMY_TBENCH_DATASET and RUMMY_TBENCH_MODEL must be set (in .env.tbench).",
	);
	process.exit(2);
}

// Resolve the per-run output directory: --out > RUMMY_TBENCH_OUT_DIR
// > timestamped default under test/tbench/results. Relative paths
// resolve against the cwd at invocation (the project root, since
// npm scripts run there). Absolute paths used as-is.
const projectRoot = join(__dirname, "..", "..");
const overrideOut = args.out ?? process.env.RUMMY_TBENCH_OUT_DIR;
let runDir;
if (overrideOut) {
	runDir = overrideOut.startsWith("/")
		? overrideOut
		: join(projectRoot, overrideOut);
} else {
	mkdirSync(RESULTS_DIR, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runSlug = args.task ?? "all";
	runDir = join(RESULTS_DIR, `${stamp}_${args.agent}_${runSlug}`);
}
mkdirSync(runDir, { recursive: true });
const logPath = join(runDir, "harbor.log");
const logStream = createWriteStream(logPath);

const venvHarbor = join(__dirname, ".venv/bin/harbor");
const harborBin = existsSync(venvHarbor) ? venvHarbor : "harbor";

// Concurrency: harbor spawns one docker container per task, so the
// bound is CPU/RAM/network on the host. `RUMMY_TBENCH_CONCURRENCY`
// lets the operator tune per-machine. Default 1 stays safe for
// single-task analysis runs (where caching + clean logs matter);
// override before a full sweep to parallelize the 89-task fan-out.
const concurrency = process.env.RUMMY_TBENCH_CONCURRENCY ?? "1";
// Per-container memory override (MiB). Bumps the cgroup limit above
// what each task.yaml declares so chromium-renderer-heavy tasks don't
// get OOM-killed at the 2 GiB default mid-run. Empty = no override
// (use task-declared memory).
const memoryMb = process.env.RUMMY_TBENCH_MEMORY_MB;
const harborArgs = [
	"run",
	"--dataset",
	dataset,
	...(args.task ? ["--include-task-name", args.task] : []),
	"--agent",
	args.agent,
	"--model",
	model,
	"--jobs-dir",
	runDir,
	"--n-concurrent",
	concurrency,
	...(memoryMb ? ["--override-memory-mb", memoryMb] : []),
];

console.log(`harbor: ${harborBin} ${harborArgs.join(" ")}`);
console.log(`logs:   ${logPath}`);
console.log(`harbor checkout: ${harborDir}`);
console.log(`concurrency: ${concurrency}`);
console.log("");

// Auto-launch sysmon alongside the sweep. Captures host RAM/swap/load,
// per-container memory, and docker OOM events into CSVs under runDir.
// Required input for the post-mortem retune of RUMMY_TBENCH_CONCURRENCY
// (and for honest "ran the full bench in X minutes" claims with peak
// resource numbers attached). Skip the daemon when --task is set —
// single-task runs don't need the metrics overhead.
const sysmonScript = join(__dirname, "sysmon.sh");
let sysmon = null;
if (!args.task && existsSync(sysmonScript)) {
	sysmon = spawn("bash", [sysmonScript, runDir, "15"], {
		stdio: ["ignore", "ignore", "pipe"],
		detached: false,
	});
	sysmon.stderr?.on("data", (chunk) =>
		process.stderr.write(`[sysmon] ${chunk}`),
	);
}

const sweepStartMs = Date.now();
const sweepStartIso = new Date(sweepStartMs).toISOString();

const child = spawn(harborBin, harborArgs, {
	stdio: ["ignore", "pipe", "pipe"],
	env: { ...process.env },
});

const tee = (src, dst) => {
	src.on("data", (chunk) => {
		dst.write(chunk);
		logStream.write(chunk);
	});
};
tee(child.stdout, process.stdout);
tee(child.stderr, process.stderr);

child.on("close", (code) => {
	logStream.end();
	if (sysmon) {
		sysmon.kill("SIGTERM");
	}
	const sweepEndMs = Date.now();
	const wallSeconds = Math.round((sweepEndMs - sweepStartMs) / 1000);
	const wallHuman = `${Math.floor(wallSeconds / 60)}m ${wallSeconds % 60}s`;

	// Sweep summary at runDir root for at-a-glance stats. Aggregating per-task
	// reward/cost/tokens lives in a separate aggregator script (reads each
	// agent/rummy.txt's `__RUMMY_RUN_SUMMARY__` line).
	const summary = {
		startedAt: sweepStartIso,
		endedAt: new Date(sweepEndMs).toISOString(),
		wallSeconds,
		wallHuman,
		harborExit: code,
		dataset,
		model,
		agent: args.agent,
		concurrency: Number(concurrency),
		task: args.task ?? null,
	};
	writeFileSync(
		join(runDir, "sweep_summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);

	console.log(`\nharbor exited code=${code}`);
	console.log(`wall time: ${wallHuman}`);
	console.log(`results: ${runDir}`);

	// Auto-build per-task digests + sweep-wide index.csv. Read-only
	// derivative of rummy.db + rummy.txt + verifier/reward.txt; safe
	// to re-run with `node test/tbench/digest.js <sweep-dir>`.
	const digestScript = join(__dirname, "digest.js");
	const digestProc = spawn("node", [digestScript, runDir], {
		stdio: "inherit",
	});
	digestProc.on("close", () => process.exit(code === null ? 1 : code));
});
