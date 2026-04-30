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
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
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

mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runSlug = args.task ?? "all";
const runDir = join(RESULTS_DIR, `${stamp}_${args.agent}_${runSlug}`);
mkdirSync(runDir, { recursive: true });
const logPath = join(runDir, "harbor.log");
const logStream = createWriteStream(logPath);

const venvHarbor = join(__dirname, ".venv/bin/harbor");
const harborBin = existsSync(venvHarbor) ? venvHarbor : "harbor";

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
	"1",
];

console.log(`harbor: ${harborBin} ${harborArgs.join(" ")}`);
console.log(`logs:   ${logPath}`);
console.log(`harbor checkout: ${harborDir}`);
console.log("");

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
	console.log(`\nharbor exited code=${code}`);
	console.log(`results: ${runDir}`);
	process.exit(code === null ? 1 : code);
});
