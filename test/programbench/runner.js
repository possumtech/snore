/**
 * ProgramBench runner for Rummy.
 *
 * Aligned with the upstream usage guide
 * (https://github.com/facebookresearch/programbench/blob/main/docs/README.md):
 * agent runs against the `task_cleanroom` image with `--network=none`;
 * submission is the workspace's produced codebase as `submission.tar.gz`;
 * eval runs the same `compile.sh` contract in the `task` image.
 *
 * Architecture: agent process lives on host (LLM API needs network).
 * Tool execution (`<sh>`/`<env>`) is proxied via `docker exec` into the
 * `task_cleanroom` container which is bind-mounted to host scratchDir.
 * File ops (`<set>`/`<rm>`) write to host scratchDir; the bind-mount
 * makes them visible inside the container immediately.
 *
 * After the agent finishes, runner runs an eval-aligned acceptance gate
 * against the `task` image — `chmod +x ./compile.sh && ./compile.sh` in
 * the actual environment programbench eval will use. If the gate fails,
 * the runner reports failure regardless of the agent's self-reported
 * status. This catches hallucinated successes where the agent never
 * verified its build cleanly.
 *
 * Usage:
 *   node test/programbench/runner.js --task <instance-id> [--model <alias>]
 *
 * Examples:
 *   node test/programbench/runner.js --task tomnomnom__gron.88a6234 --model grok
 *   node test/programbench/runner.js --task tomnomnom_1776_gron.88a6234 --model grok
 *
 * Either form of slug is accepted; internally we normalize to canonical
 * (`__`) for task data lookup and to Docker (`_1776_`) for image names.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
const PB_VENV = join(__dirname, ".venv");
const TASKS_DATA_DIR = join(
	PB_VENV,
	"lib",
	`python${detectPythonMajorMinor()}`,
	"site-packages",
	"programbench",
	"data",
	"tasks",
);

function detectPythonMajorMinor() {
	const lib = join(PB_VENV, "lib");
	if (!existsSync(lib)) return "python3.13";
	const dirs = execSync(`ls ${lib} 2>/dev/null`).toString().trim().split("\n");
	const match = dirs.find((d) => /^python\d+\.\d+$/.test(d));
	return match || "python3.13";
}

const { values: args } = parseArgs({
	options: {
		task: { type: "string" },
		model: { type: "string" },
		out: { type: "string" },
	},
	strict: false,
});

if (!args.task) {
	console.error("usage: node runner.js --task <instance-id> [--model <alias>]");
	process.exit(2);
}

// Slug normalization. Programbench's data dir + canonical instance id
// uses `__`; Docker image names use `_1776_` (Docker disallows `__`).
// Accept either form from the user.
const INSTANCE_ID = args.task.replace(/_1776_/g, "__");
const DOCKER_SLUG = INSTANCE_ID.replace(/__/g, "_1776_");
const MODEL = args.model || process.env.RUMMY_PROGRAMBENCH_MODEL || "grok";
const CLEANROOM_IMAGE = `programbench/${DOCKER_SLUG}:task_cleanroom`;
const TASK_IMAGE = `programbench/${DOCKER_SLUG}:task`;

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runRoot = args.out ? args.out : join(RESULTS_DIR, runId);
// Layout matches upstream: <run-root>/<instance>/submission.tar.gz.
// Sibling `agent/` and `workspace/` dirs are admin/scratch — eval
// ignores them, they exist for our audit + replay.
const runDir = join(runRoot, INSTANCE_ID);
const scratchDir = join(runDir, "workspace");
const adminDir = join(runDir, "agent");

function sh(cmd, opts = {}) {
	return execSync(cmd, { encoding: "utf8", stdio: "pipe", ...opts });
}

function readTaskMetadata() {
	const yamlPath = join(TASKS_DATA_DIR, INSTANCE_ID, "task.yaml");
	if (!existsSync(yamlPath)) return null;
	const text = readFileSync(yamlPath, "utf8");
	const meta = {};
	for (const line of text.split("\n")) {
		const m = line.match(/^([a-z_]+):\s*(.+)$/);
		if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
	}
	return meta;
}

async function ensureImage(image) {
	const have = sh(`docker images -q ${image}`).trim();
	if (have) return;
	console.error(`pulling ${image}…`);
	execSync(`docker pull ${image}`, { stdio: "inherit" });
}

async function extractWorkspace() {
	await fs.mkdir(scratchDir, { recursive: true });
	await fs.mkdir(adminDir, { recursive: true });
	const cid = sh(`docker create ${CLEANROOM_IMAGE}`).trim();
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

const containerName = `programbench_${runId.replace(/[^a-zA-Z0-9_.-]/g, "_")}_${INSTANCE_ID.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;

async function startSandbox() {
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
			CLEANROOM_IMAGE,
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

// Prompt template lives in prompt.md so it's collaboratively editable
// without code edits. `{{orientation}}` is the only template variable —
// the conditional language/repo line is built here because simple
// {{var}} substitution can't gracefully drop a sentence when fields
// are missing in task.yaml.
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "prompt.md"), "utf8");

function buildPrompt(taskMeta) {
	const language = taskMeta?.language;
	const repository = taskMeta?.repository;
	const langLine = language
		? `The reference is implemented in ${language}.`
		: "";
	const repoLine = repository
		? `Upstream repository: https://github.com/${repository}.`
		: "";
	const orientation = [langLine, repoLine].filter(Boolean).join(" ");
	return PROMPT_TEMPLATE.replace("{{orientation}}", orientation).trimEnd();
}

async function listProducedFiles() {
	const exclude = new Set(["executable", ".git"]);
	const all = await fs.readdir(scratchDir);
	return all.filter((name) => !exclude.has(name));
}

async function foldDbIntoWorkspace() {
	const srcDb = join(adminDir, "rummy_programbench.db");
	if (!existsSync(srcDb)) return;
	const dstDb = join(scratchDir, "rummy_programbench.db");
	try {
		execFileSync("sqlite3", [srcDb, `.backup ${dstDb}`], { stdio: "pipe" });
	} catch {
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
	const tarArgs = ["-czf", submissionPath, "-C", scratchDir, ...produced];
	execFileSync("tar", tarArgs, { stdio: "inherit" });
	console.error(`wrote ${submissionPath}`);
	return true;
}

async function runAgent(taskMeta) {
	const env = {
		...process.env,
		RUMMY_PROMPT: buildPrompt(taskMeta),
		RUMMY_MODEL: MODEL,
		RUMMY_MODE: "act",
		RUMMY_NO_WEB: "1",
		RUMMY_YOLO: "1",
		RUMMY_DB_PATH: join(adminDir, "rummy_programbench.db"),
		// `--user` aligns container UID/GID with host so files created
		// in the container (e.g. `<sh>touch src/foo.go</sh>`) are
		// writable by the host process. Without this, container default
		// is root → host's `set.js #materializeFile` writeFile gets
		// EACCES on those files and the loop crashes mid-turn.
		RUMMY_SHELL_ARGV: JSON.stringify([
			"docker",
			"exec",
			"--user",
			`${process.getuid()}:${process.getgid()}`,
			"--workdir",
			"/workspace",
			containerName,
			"bash",
			"-lc",
		]),
		// No RUMMY_PROJECT_FILES override: the default git-tracked-files
		// scan picks up the workspace's actual docs (README.mkd, LICENSE,
		// ADVANCED.mkd, etc.). The executable is left out by perms
		// (0o111 unreadable) and by being untracked in the cleanroom's
		// .git stub. Whitelisting `README.md,COPYING,*.1` (the prior
		// hardcoded list) was non-portable across tasks — gron has
		// `.mkd` not `.md`, no `COPYING`, no `*.1`.
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

// Acceptance gate: run the eval's exact compile sequence in a fresh
// container off the `task` image (the same image programbench eval
// uses). Tells us truthfully whether the agent's submission would
// build under eval — independent of any "complete" status the agent
// emitted in its own run.
async function evalAcceptanceGate() {
	console.error(`\nacceptance gate: pulling ${TASK_IMAGE}…`);
	await ensureImage(TASK_IMAGE);
	const gateContainer = `${containerName}_gate`;
	console.error(`acceptance gate: building submission in ${TASK_IMAGE}…`);
	let returncode;
	let output;
	try {
		execFileSync(
			"docker",
			[
				"run",
				"-d",
				"--rm",
				"--network=none",
				"--name",
				gateContainer,
				TASK_IMAGE,
				"sleep",
				"60",
			],
			{ stdio: "pipe" },
		);
		// Replicate eval's wipe + extract pattern.
		execFileSync(
			"docker",
			[
				"exec",
				gateContainer,
				"bash",
				"-lc",
				"rm -rf /workspace/* /workspace/.[!.]*",
			],
			{ stdio: "pipe" },
		);
		const submissionPath = join(runDir, "submission.tar.gz");
		execFileSync(
			"docker",
			["cp", submissionPath, `${gateContainer}:/tmp/submission.tar.gz`],
			{
				stdio: "pipe",
			},
		);
		execFileSync(
			"docker",
			[
				"exec",
				gateContainer,
				"bash",
				"-lc",
				"cd /workspace && tar -xzf /tmp/submission.tar.gz",
			],
			{ stdio: "pipe" },
		);
		const result = execFileSync(
			"docker",
			[
				"exec",
				gateContainer,
				"bash",
				"-lc",
				"chmod +x ./compile.sh && ./compile.sh",
			],
			{ encoding: "utf8", stdio: "pipe" },
		);
		returncode = 0;
		output = result;
	} catch (err) {
		returncode = err.status ?? 1;
		output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
	} finally {
		try {
			execFileSync("docker", ["rm", "-f", gateContainer], { stdio: "ignore" });
		} catch {}
	}
	if (returncode === 0) {
		console.error("acceptance gate: ✓ compile.sh succeeded in task image");
	} else {
		console.error(
			`acceptance gate: ✗ compile.sh failed (rc=${returncode}) in task image:\n${output.trim()}`,
		);
	}
	return returncode === 0;
}

const taskMeta = readTaskMetadata();
if (taskMeta) {
	console.error(
		`task: ${INSTANCE_ID} (${taskMeta.language || "?"}, ${taskMeta.repository || "?"})`,
	);
} else {
	console.error(
		`task: ${INSTANCE_ID} (no task.yaml found — programbench data may not be installed)`,
	);
}

await ensureImage(CLEANROOM_IMAGE);
await extractWorkspace();
console.error(`workspace ready at ${scratchDir}`);
await startSandbox();
console.error(`sandbox started: ${containerName} (--network=none)`);

let agentExit;
try {
	agentExit = await runAgent(taskMeta);
} finally {
	await stopSandbox();
	console.error(`sandbox stopped: ${containerName}`);
}
console.error(`rummy exited with code ${agentExit}`);

await foldDbIntoWorkspace();
const submitted = await tarSubmission();
if (!submitted) process.exit(1);

const gatePassed = await evalAcceptanceGate();
// Exit reflects truth, not agent's self-report: a passed gate means
// the submission would compile under programbench eval.
process.exit(agentExit === 0 && gatePassed ? 0 : 1);
