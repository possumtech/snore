/**
 * ProgramBench runner for Rummy. Single-task end-to-end:
 *   1. Pull `programbench/<task>:task_cleanroom` if missing.
 *   2. Extract /workspace into a scratch project root, preserving
 *      the executable's no-read permission.
 *   3. Run rummy-cli (act mode, noWeb, gemma) against the scratch
 *      dir with a task-shaped prompt.
 *   4. After the agent finishes, fold the run's `rummy.db` into the
 *      workspace and tar everything except the executable (which
 *      the eval rebuilds) and `.git` (clean stub). The submission
 *      includes the audit trail so a public reviewer can replay
 *      the agent's reasoning, not just inspect its output.
 *
 * Deviation from canonical mini-swe-agent harness: the agent runs on
 * host, not inside the cleanroom container, and operates the scratch
 * dir directly (no docker exec). `<sh>` therefore runs on the host
 * shell. Internet exfiltration is gated only by `RUMMY_NO_WEB=1`
 * (drops the `<search>` tool); the host does have generic network
 * reach. Documented exception per AGENTS.md ProgramBench note.
 *
 * Usage:
 *   node test/programbench/runner.js --task <task-image-slug>
 *
 * Example:
 *   node test/programbench/runner.js \
 *     --task abishekvashok_1776_cmatrix.5c082c6
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

const { values: args } = parseArgs({
	options: {
		task: { type: "string" },
		model: { type: "string" },
		out: { type: "string" },
	},
	strict: false,
});

if (!args.task) {
	console.error("usage: node runner.js --task <task-image-slug>");
	process.exit(2);
}

const TASK = args.task;
const MODEL = args.model || process.env.RUMMY_PROGRAMBENCH_MODEL || "gemma";
const IMAGE = `programbench/${TASK}:task_cleanroom`;

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = args.out ? args.out : join(RESULTS_DIR, runId, taskKey(TASK));
// Layout mirrors tbench's diag-dir convention: workspace/ holds the
// agent's project root (its `cwd`); agent/ holds the run's audit
// artifacts (DB, future log files). Keeps admin files out of the
// agent's filesystem-traversal range — `<sh>cd ..</sh>` from workspace
// lands one dir above admin, not co-located with it.
const scratchDir = join(runDir, "workspace");
const adminDir = join(runDir, "agent");

function taskKey(slug) {
	// Convert dockerhub `_1776_` back to canonical `__` instance id.
	return slug.replace(/_1776_/, "__");
}

function sh(cmd, opts = {}) {
	return execSync(cmd, { encoding: "utf8", stdio: "pipe", ...opts });
}

async function ensureImage() {
	const have = sh(`docker images -q ${IMAGE}`).trim();
	if (have) return;
	console.error(`pulling ${IMAGE}…`);
	execSync(`docker pull ${IMAGE}`, { stdio: "inherit" });
}

async function extractWorkspace() {
	await fs.mkdir(scratchDir, { recursive: true });
	await fs.mkdir(adminDir, { recursive: true });
	// Create a stopped container so we can `docker cp` /workspace out.
	const cid = sh(`docker create ${IMAGE}`).trim();
	try {
		execSync(`docker cp ${cid}:/workspace/. ${scratchDir}/`, {
			stdio: "inherit",
		});
	} finally {
		execFileSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
	}
	// Re-apply benchmark-integrity perms on the executable: the agent
	// can run it but cannot read its bytes (forbidden decompilation).
	const exePath = join(scratchDir, "executable");
	if (existsSync(exePath)) await fs.chmod(exePath, 0o111);
}

// Container name: per-run unique, sweep-safe. Docker name regex is
// [a-zA-Z0-9_.-]; sanitize the run-id and task slug to fit.
const containerName = `programbench_${runId.replace(/[^a-zA-Z0-9_.-]/g, "_")}_${taskKey(TASK).replace(/[^a-zA-Z0-9_.-]/g, "_")}`;

async function startSandbox() {
	// Long-lived cleanroom container with no network access. Bind-mount
	// the host scratchDir → /workspace so the agent's host-side file ops
	// and the container's docker-exec view stay in sync. `--network=none`
	// satisfies ProgramBench's "agent must not have internet during
	// inference" contract at the kernel level — a tool-list filter
	// (RUMMY_NO_WEB) can't enforce this; the network namespace can.
	execFileSync(
		"docker",
		[
			"run",
			"-d",
			"--rm",
			"--network=none",
			"--name",
			containerName,
			"-v",
			`${scratchDir}:/workspace`,
			"-w",
			"/workspace",
			IMAGE,
			"sleep",
			"infinity",
		],
		{ stdio: "pipe" },
	);
}

async function stopSandbox() {
	try {
		execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
	} catch {}
}

function buildPrompt() {
	// Aligned to the mini-swe-agent SWE-bench reference prompt structure
	// — verbatim where possible, substituted only for the structural
	// differences between the benchmarks (issue→task, repo→workspace,
	// implicit git-diff submission → explicit compile.sh contract). See
	// AGENTS.md "Benchmark integrity": this stays as protocol-bridging,
	// not strategy-directing.
	return [
		"We're currently reproducing the following program from scratch.",
		"",
		"The compiled binary `./executable` is the reference. You have access",
		"to its documentation (`./README.md`, `./*.1`, `./COPYING`) and runtime",
		"data files in `./data/` (if present). The binary itself is",
		"executable-only — you cannot read or decompile it.",
		"",
		"INSTRUCTIONS:",
		"Now, you're going to reproduce this program on your own. Your session",
		"has started and you're in the workspace's root directory. Edit all the",
		"files you need to and run any checks or tests that you want.",
		"",
		"The eval will run `chmod +x ./compile.sh && ./compile.sh` to build your",
		"submission, then test the resulting `./executable` against a behavioral",
		"suite. Your submission must include `./compile.sh` and any source files",
		"it needs.",
		"",
		"Try to reproduce the binary's observable behavior as faithfully as",
		"possible.",
	].join("\n");
}

async function listProducedFiles() {
	// Tar EVERYTHING in workspace except the original binary and the
	// (clean) git stub. The agent may reference docs / data / man
	// pages as part of its produced codebase (e.g., installing the
	// man page in a Makefile target), so excluding inputs would risk
	// shipping a submission that fails to build for missing assets.
	// The eval rebuilds from the tar — extras don't hurt; missing
	// files do.
	const exclude = new Set(["executable", ".git"]);
	const all = await fs.readdir(scratchDir);
	return all.filter((name) => !exclude.has(name));
}

async function foldDbIntoWorkspace() {
	// Copy rummy_programbench.db into the workspace so the submission
	// tar contains the agent's full reasoning trace alongside the
	// produced codebase. Public reviewers can `npm run dev:digest`
	// against the extracted DB to see every turn the agent took.
	const srcDb = join(adminDir, "rummy_programbench.db");
	if (!existsSync(srcDb)) return;
	const dstDb = join(scratchDir, "rummy_programbench.db");
	// Use sqlite3 .backup so the copy is consistent even if the writer
	// hasn't fully flushed WAL (matches dev:digest's pattern).
	try {
		execFileSync("sqlite3", [srcDb, `.backup ${dstDb}`], { stdio: "pipe" });
	} catch {
		// Fallback to plain copy if sqlite3 is unavailable; WAL may be
		// missed but the main DB still has most data.
		await fs.copyFile(srcDb, dstDb);
	}
}

async function tarSubmission() {
	const produced = await listProducedFiles();
	if (produced.length === 0) {
		console.error("no produced files — submission would be empty; aborting");
		return false;
	}
	const submissionPath = join(runDir, "submission.tar.gz");
	const args = ["-czf", submissionPath, "-C", scratchDir, ...produced];
	execFileSync("tar", args, { stdio: "inherit" });
	console.error(`wrote ${submissionPath}`);
	return true;
}

async function runAgent() {
	const env = {
		...process.env,
		RUMMY_PROMPT: buildPrompt(),
		RUMMY_MODEL: MODEL,
		RUMMY_MODE: "act",
		RUMMY_NO_WEB: "1",
		RUMMY_YOLO: "1",
		// Per-run DB pinned to the run dir so `npm run dev:digest <path>`
		// works mid-run for turn-by-turn observation, and so the file
		// can be folded into the submission tar after the run for a
		// fully-transparent record of the agent's reasoning trace.
		RUMMY_DB_PATH: join(adminDir, "rummy_programbench.db"),
		// Route yolo's <sh>/<env> exec through the per-task cleanroom
		// container. Inside the container the agent has no network reach
		// (--network=none) — required by ProgramBench. File ops continue
		// to operate on the host scratchDir because the bind-mount keeps
		// host and container views in sync.
		RUMMY_SHELL_ARGV: JSON.stringify([
			"docker",
			"exec",
			"--workdir",
			"/workspace",
			containerName,
			"bash",
			"-lc",
		]),
		// Project surface: docs + data only. The executable is excluded
		// from ingestion (perms `---x--x--x` would fail file reads); the
		// model probes its behavior via `<sh>./executable …` instead.
		// `.git` is also excluded (clean stub, but no benchmark value).
		RUMMY_PROJECT_FILES: "README.md,COPYING,*.1,data/**",
	};
	const cliBin = join(__dirname, "..", "..", "src", "plugins", "cli", "bin.js");
	return new Promise((resolve, reject) => {
		const child = spawn("node", [cliBin], {
			cwd: scratchDir,
			env,
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve(code ?? 1));
	});
}

await ensureImage();
await extractWorkspace();
console.error(`workspace ready at ${scratchDir}`);
await startSandbox();
console.error(`sandbox started: ${containerName} (--network=none)`);
let exitCode;
try {
	exitCode = await runAgent();
} finally {
	await stopSandbox();
	console.error(`sandbox stopped: ${containerName}`);
}
console.error(`rummy exited with code ${exitCode}`);
await foldDbIntoWorkspace();
await tarSubmission();
process.exit(exitCode);
