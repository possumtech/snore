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
const scratchDir = join(runDir, "workspace");

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

function buildPrompt() {
	// Keep the prompt task-agnostic; rummy reads the docs itself.
	return [
		"Reproduce the program in `./executable` from scratch.",
		"",
		"Inputs you have:",
		"- `./executable` — the compiled binary you must reproduce.",
		"  Executable-only (cannot be read or decompiled).",
		"- `./README.md`, `./*.1`, `./COPYING` — documentation.",
		"- `./data/` — runtime data files the binary uses (if present).",
		"",
		"Submission contract — your codebase must satisfy this exactly:",
		"- `./compile.sh` — executable shell script that builds your",
		"  source into a binary at `./executable` (overwriting the",
		"  reference binary in the eval workspace). The eval pipeline",
		"  runs `chmod +x ./compile.sh && ./compile.sh` then tests the",
		"  resulting `./executable` against a behavioral test suite.",
		"- All source files needed for compile.sh to succeed.",
		"",
		"Your job:",
		"- Probe the binary's behavior by running it; do not speculate",
		"  from docs alone. The behavioral tests match the binary, not",
		"  the README.",
		"- Write source AND `compile.sh`. Both are mandatory.",
		"- VERIFY YOUR BUILD before declaring done. Run",
		"  `chmod +x ./compile.sh && ./compile.sh` and confirm it",
		"  exits 0 and produces `./executable`. Run your binary",
		"  against a sample input and compare to the reference's",
		"  output. Don't emit `<update status=\"200\">` until you've",
		"  verified end-to-end.",
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
	const srcDb = join(runDir, "rummy_programbench.db");
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
		RUMMY_DB_PATH: join(runDir, "rummy_programbench.db"),
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
const exitCode = await runAgent();
console.error(`rummy exited with code ${exitCode}`);
await foldDbIntoWorkspace();
await tarSubmission();
process.exit(exitCode);
