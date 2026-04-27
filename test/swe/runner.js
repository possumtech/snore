/**
 * SWE-bench Verified Mini runner for Rummy.
 *
 * For each task: clone the repo at base_commit into a working dir,
 * spin up rummy in act mode, hand the agent the problem statement,
 * auto-accept proposals, capture `git diff` as the model patch,
 * append to predictions.jsonl. SWE-bench's official eval harness
 * scores the predictions afterward.
 *
 * Usage:
 *   node test/swe/runner.js                  # all 50 tasks
 *   node test/swe/runner.js --row 0          # single task
 *   node test/swe/runner.js --row 0-4        # range
 *   node test/swe/runner.js --model gemma    # override model
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const RESULTS_DIR = join(__dirname, "results");
const REPOS_DIR = join(__dirname, "repos");
const MAX_TURNS = 99;

const { values: args } = parseArgs({
	options: {
		row: { type: "string" },
		model: { type: "string" },
		split: { type: "string", default: "test" },
	},
	strict: false,
});

const MODEL = args.model || process.env.RUMMY_TEST_MODEL;

function parseRange(spec) {
	if (!spec) return null;
	if (spec.includes("-")) {
		const [start, end] = spec.split("-").map(Number);
		return { start, end };
	}
	const n = Number(spec);
	return { start: n, end: n };
}

function loadTasks(split) {
	const path = join(DATA_DIR, `${split}.ndjson`);
	if (!existsSync(path))
		throw new Error(`Missing data: ${path}\nRun: npm run test:swe:get`);
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function sh(cmd, opts = {}) {
	return execSync(cmd, { encoding: "utf8", stdio: "pipe", ...opts });
}

async function prepareRepo(task) {
	// Cache one shared mirror per repo (treeless partial clone — fast,
	// small, full history). Per-task working dirs are local clones from
	// that mirror, checked out at the task's base_commit.
	const [owner, repo] = task.repo.split("/");
	const url = `https://github.com/${owner}/${repo}.git`;
	const mirrorDir = join(REPOS_DIR, ".mirrors", `${owner}__${repo}.git`);
	const slug = task.instance_id.replace(/[^a-zA-Z0-9_-]/g, "_");
	const dest = join(REPOS_DIR, slug);

	await fs.mkdir(join(REPOS_DIR, ".mirrors"), { recursive: true });

	if (!existsSync(mirrorDir)) {
		console.log(`    fetching mirror ${task.repo} (treeless)`);
		sh(
			`git clone --bare --filter=tree:0 --quiet ${url} ${mirrorDir}`,
		);
	}

	await fs.rm(dest, { recursive: true, force: true });
	console.log(`    checkout ${task.repo} @ ${task.base_commit.slice(0, 8)}`);
	sh(`git clone --quiet ${mirrorDir} ${dest}`);
	sh(`git checkout --quiet ${task.base_commit}`, { cwd: dest });
	return dest;
}

function buildPrompt(task) {
	const lines = [
		"You are working in a git repository to fix a real issue.",
		"",
		"## Issue",
		task.problem_statement.trim(),
	];
	if (task.hints_text?.trim()) {
		lines.push("", "## Hints", task.hints_text.trim());
	}
	lines.push(
		"",
		"## Approach",
		"- Read the relevant source files with <get>.",
		"- Use <sh> to run failing tests and observe behavior before and after edits.",
		"- Write the fix using <set> with patch or search/replace blocks.",
		"- Re-run the failing tests with <sh> to confirm the fix.",
		"- When tests pass, complete with <update status=\"200\">summary</update>.",
		"",
		`## Failing tests (must pass after fix)`,
		task.FAIL_TO_PASS,
	);
	return lines.join("\n");
}

function captureDiff(repoPath) {
	try {
		const diff = sh("git diff HEAD", { cwd: repoPath });
		return diff;
	} catch (err) {
		console.error(`    diff failed: ${err.message}`);
		return "";
	}
}

async function runTask(client, model, task) {
	console.log(`\n  [${task.instance_id}]`);
	const startTime = Date.now();

	const repoPath = await prepareRepo(task);

	// Re-handshake project root for this task. AuditClient also needs
	// projectRoot for client-side disk apply (defense in depth — server's
	// set plugin writes via #materializeFile too, but having both means
	// either path delivers).
	await client.call("rummy/hello", {
		name: "SWE",
		projectRoot: repoPath,
	});
	client.projectRoot = repoPath;

	const prompt = buildPrompt(task);

	// AuditClient auto-resolves proposals (run/proposal notifications) so
	// client.act() runs to terminal without manual proposal draining.
	const r = await client.act({
		model,
		prompt,
		noInteraction: true,
		noWeb: true,
	});

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
	const diff = captureDiff(repoPath);
	const ok = diff.length > 0;

	console.log(
		`    ${ok ? "✓" : "✗"} status=${r.status} diff=${diff.length}b — ${elapsed}s`,
	);

	return {
		instance_id: task.instance_id,
		model_name_or_path: `rummy-${model}`,
		model_patch: diff,
		_meta: {
			runStatus: r.status,
			runAlias: r.run,
			elapsedSec: Number(elapsed),
		},
	};
}

async function main() {
	if (!MODEL) {
		console.error("No model configured. Set RUMMY_TEST_MODEL in .env.test");
		process.exit(1);
	}

	const tasks = loadTasks(args.split);
	const range = parseRange(args.row);
	const start = range?.start ?? 0;
	const end = Math.min(range?.end ?? tasks.length - 1, tasks.length - 1);

	console.log(`SWE-bench Verified Mini Runner`);
	console.log(`Model: ${MODEL}`);
	console.log(`Tasks: ${start}-${end} of ${tasks.length}`);
	console.log(`Max turns: ${MAX_TURNS}`);

	await fs.mkdir(RESULTS_DIR, { recursive: true });
	await fs.mkdir(REPOS_DIR, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runDir = join(RESULTS_DIR, timestamp);
	await fs.mkdir(runDir, { recursive: true });
	process.env.RUMMY_HOME = runDir;

	const dbPath = join(runDir, "swe.db");
	const tdb = await TestDb.createAt(dbPath, "swe");
	const tserver = await TestServer.start(tdb);
	const client = new AuditClient(tserver.url, tdb.db);
	await client.connect();

	const predictionsPath = join(runDir, "predictions.jsonl");
	const metaPath = join(runDir, "meta.jsonl");

	console.log(`Database: ${dbPath}`);
	console.log(`Predictions: ${predictionsPath}\n`);

	let resolved = 0;
	try {
		for (let i = start; i <= end; i++) {
			const task = tasks[i];
			try {
				const result = await runTask(client, MODEL, task);
				const { _meta, ...prediction } = result;
				await fs.appendFile(predictionsPath, `${JSON.stringify(prediction)}\n`);
				await fs.appendFile(
					metaPath,
					`${JSON.stringify({ instance_id: result.instance_id, ..._meta })}\n`,
				);
				if (result.model_patch.length > 0) resolved++;
			} catch (err) {
				console.error(`    crashed: ${err.message}`);
				await fs.appendFile(
					predictionsPath,
					`${JSON.stringify({
						instance_id: task.instance_id,
						model_name_or_path: `rummy-${MODEL}`,
						model_patch: "",
					})}\n`,
				);
			}
		}
	} finally {
		await client?.close();
		await tserver?.stop();
		await tdb.cleanup();
	}

	const total = end - start + 1;
	console.log(
		`\nProduced patches: ${resolved}/${total} (${((resolved / total) * 100).toFixed(0)}%)`,
	);
	console.log(`\nNext: npm run test:swe:eval -- ${runDir}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
