/**
 * tbench digest tool. Walks a sweep dir (or a single task dir),
 * reads each task's rummy.db + rummy.txt + verifier/reward.txt, and
 * emits four artifacts per task plus one sweep-wide index:
 *
 *   <task-dir>/digest.md      Waterfall: per-turn one-liner with status,
 *                             update body, and indented emission list.
 *                             Human + agent scan target.
 *   <task-dir>/digest.json    Same data, machine-queryable. Markers,
 *                             counts, paths.
 *   <task-dir>/reasoning.md   Per-turn reasoning_content bracketed by
 *                             `## Turn N` headers. Drill-down anchor
 *                             when the waterfall raises a question.
 *   <task-dir>/digest_skipped Empty file. Written when rummy.db is
 *                             absent (exfil-fail, harbor crash before
 *                             agent ran). Tells future passes "we
 *                             tried, no data."
 *
 *   <sweep-dir>/index.csv     One row per task: name, reward, status,
 *                             turns, tokens, cost, wall, markers.
 *                             Greppable triage front door.
 *
 * The digest is a read-only derivative; never source-of-truth. Safe
 * to re-run on the same input.
 *
 * Usage:
 *   node test/tbench/digest.js <sweep-dir>           # sweep + index
 *   node test/tbench/digest.js <task-dir>            # single task
 *   node test/tbench/digest.js                       # latest sweep
 */
import { DatabaseSync } from "node:sqlite";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

const MAX_LOOP_TURNS = Number(process.env.RUMMY_MAX_LOOP_TURNS) || 99;
// Reasoning-runaway threshold: a turn with this much reasoning AND no
// productive emissions is a strong runaway signal. Tunable.
const REASONING_RUNAWAY_CHARS = 8000;

function isTaskDir(dir) {
	return existsSync(join(dir, "agent", "rummy.db"));
}

function findTaskDirs(sweepDir) {
	const result = [];
	function walk(dir, depth) {
		if (depth > 4) return;
		let names;
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const full = join(dir, name);
			let s;
			try {
				s = statSync(full);
			} catch {
				continue;
			}
			if (!s.isDirectory()) continue;
			if (isTaskDir(full)) {
				result.push(full);
				continue;
			}
			walk(full, depth + 1);
		}
	}
	walk(sweepDir, 0);
	return result;
}

function readReward(taskDir) {
	const p = join(taskDir, "verifier", "reward.txt");
	if (!existsSync(p)) return null;
	const r = readFileSync(p, "utf8").trim();
	if (r === "0" || r === "1") return Number(r);
	return null;
}

function readRunSummary(taskDir) {
	const p = join(taskDir, "agent", "rummy.txt");
	if (!existsSync(p)) return null;
	const text = readFileSync(p, "utf8");
	const m = text.match(/__RUMMY_RUN_SUMMARY__\s+(\{.*\})\s*$/m);
	if (!m) return null;
	try {
		return JSON.parse(m[1]);
	} catch {
		return null;
	}
}

function parseAttrs(s) {
	if (s == null) return {};
	if (typeof s === "object") return s;
	try {
		return JSON.parse(s);
	} catch {
		return {};
	}
}

const TURN_FROM_PATH = /^log:\/\/turn_(\d+)\//;

function turnFromPath(path) {
	const m = TURN_FROM_PATH.exec(path);
	return m ? Number(m[1]) : null;
}

function actionFromPath(path) {
	const m = path.match(/^log:\/\/turn_\d+\/([^/]+)\//);
	return m ? m[1] : null;
}

function pathSlug(path) {
	// Decode the slug after `log://turn_N/<action>/`. URL-encoded.
	const m = path.match(/^log:\/\/turn_\d+\/[^/]+\/(.+)$/);
	if (!m) return path;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return m[1];
	}
}

function summarize(text, n = 80) {
	if (!text) return "";
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= n) return flat;
	return `${flat.slice(0, n)}…`;
}

function readDb(rummyDb) {
	const db = new DatabaseSync(rummyDb, { readOnly: true });

	const run = db.prepare("SELECT * FROM runs LIMIT 1").get();
	const runId = run?.id;

	const turns = db
		.prepare(
			`SELECT sequence, total_tokens, prompt_tokens, completion_tokens,
			        cached_tokens, reasoning_tokens, reasoning_content
			 FROM turns
			 WHERE run_id = ?
			 ORDER BY sequence`,
		)
		.all(runId);

	// All log entries (model emissions are recorded as log://turn_N/<action>/<slug>).
	// Plus the run-state entries (unknown://, known://, file paths).
	const logEntries = db
		.prepare(
			`SELECT e.path, e.body, e.attributes, e.scheme,
			        rv.state, rv.outcome, rv.visibility, rv.turn
			 FROM entries e
			 JOIN run_views rv ON rv.entry_id = e.id
			 WHERE rv.run_id = ?
			   AND e.path LIKE 'log://turn_%'
			 ORDER BY e.id`,
		)
		.all(runId);

	const promptEntry = db
		.prepare(
			`SELECT e.body
			 FROM entries e
			 JOIN run_views rv ON rv.entry_id = e.id
			 WHERE rv.run_id = ? AND e.path = 'prompt://1'
			 LIMIT 1`,
		)
		.get(runId);

	db.close();

	return { run, turns, logEntries, prompt: promptEntry?.body ?? null };
}

// Build per-turn rows: one entry per turn with its update + emissions + errors.
function buildTurns(turns, logEntries) {
	const byTurn = new Map();
	for (const t of turns) {
		byTurn.set(t.sequence, {
			turn: t.sequence,
			totalTokens: t.total_tokens,
			promptTokens: t.prompt_tokens,
			completionTokens: t.completion_tokens,
			cachedTokens: t.cached_tokens,
			reasoningTokens: t.reasoning_tokens,
			reasoningChars: (t.reasoning_content || "").length,
			reasoning: t.reasoning_content || "",
			update: null, // {status, body, state, outcome}
			emissions: [], // {action, slug, attrs, body, state, outcome}
			errors: [], // {body, attrs}
		});
	}
	// Make sure we have a row even for "ghost" turns where the LLM call
	// failed before turn-row creation (rare but possible).
	for (const e of logEntries) {
		const turn = turnFromPath(e.path);
		if (turn == null) continue;
		if (!byTurn.has(turn)) {
			byTurn.set(turn, {
				turn,
				totalTokens: null,
				promptTokens: null,
				completionTokens: null,
				cachedTokens: null,
				reasoningTokens: null,
				reasoningChars: 0,
				reasoning: "",
				update: null,
				emissions: [],
				errors: [],
			});
		}
		const row = byTurn.get(turn);
		const action = actionFromPath(e.path);
		const attrs = parseAttrs(e.attributes);
		if (action === "update") {
			row.update = {
				status: attrs.status ?? null,
				body: e.body,
				state: e.state,
				outcome: e.outcome,
			};
		} else if (action === "error") {
			row.errors.push({
				body: e.body,
				attrs,
				slug: pathSlug(e.path),
			});
		} else {
			row.emissions.push({
				action,
				slug: pathSlug(e.path),
				targetPath: attrs.path ?? null,
				visibility: attrs.visibility ?? null,
				query: attrs.query ?? null,
				command: attrs.command ?? null,
				body: e.body,
				state: e.state,
				outcome: e.outcome,
			});
		}
	}
	return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

function classifyMarkers(reward, runSummary, turnRows) {
	const markers = [];
	const status = runSummary?.status ?? null;
	if (reward === 1) markers.push("passed");
	if (reward === 0 && status === 200) markers.push("claim_success_verifier_fail");
	if (status === 499 && turnRows.length >= MAX_LOOP_TURNS - 1) {
		markers.push("max_loop_turns");
	}
	if (status === 413) markers.push("context_overflow");
	if (status === 500) markers.push("dispatch_500");

	let strikeAbandon = false;
	let runawayTurn = null;
	const shieldHits = new Set();
	let parserWarn = false;
	for (const row of turnRows) {
		// Reasoning runaway: heavy reasoning, no productive emissions.
		if (
			row.reasoningChars >= REASONING_RUNAWAY_CHARS &&
			row.emissions.length === 0 &&
			!row.update
		) {
			runawayTurn = row.turn;
		}
		for (const err of row.errors) {
			const body = err.body || "";
			if (body.startsWith("Abandoned after")) strikeAbandon = true;
			if (body.includes("YOU MUST ONLY define unknowns"))
				shieldHits.add("shield_0");
			else if (body.includes("YOU MUST identify unknowns"))
				shieldHits.add("shield_1");
			else if (body.includes("YOU MUST identify knowns"))
				shieldHits.add("shield_2");
			else if (body.includes("YOU MUST NOT deliver file modifications"))
				shieldHits.add("shield_3");
			if (body.startsWith("Unclosed") || body.includes("Tool call limit")) {
				parserWarn = true;
			}
		}
	}
	if (strikeAbandon) markers.push("strike_abandon");
	for (const m of [...shieldHits].sort()) markers.push(m);
	if (runawayTurn != null) markers.push(`reasoning_runaway_t${runawayTurn}`);
	if (parserWarn) markers.push("parser_warning");
	if (!runSummary) markers.push("exfil_fail");
	return markers;
}

// Render an emission as a single waterfall line.
function renderEmission(em) {
	const fail = em.state === "failed" ? " ✗" : "";
	const outcome = em.outcome ? ` [${em.outcome}]` : "";
	const target = em.targetPath ?? em.slug;
	const vis = em.visibility ? ` visibility=${em.visibility}` : "";
	const query = em.query ? ` "${summarize(em.query, 60)}"` : "";
	const command = em.command ? ` "${summarize(em.command, 60)}"` : "";
	return `  ← ${em.action} ${target}${vis}${query}${command}${fail}${outcome}`;
}

function renderError(err) {
	return `  ✗ error: ${summarize(err.body, 100)}`;
}

function renderWaterfall(taskName, prompt, runSummary, reward, turnRows, markers) {
	const lines = [];
	lines.push(`# ${taskName}`);
	lines.push("");
	const status = runSummary?.status ?? "?";
	const totalTurns = runSummary?.turns ?? turnRows.length;
	const cost = runSummary?.cost != null ? `$${runSummary.cost.toFixed(4)}` : "?";
	const tokens = runSummary?.tokens
		? `prompt=${runSummary.tokens.prompt} completion=${runSummary.tokens.completion} cached=${runSummary.tokens.cached}`
		: "?";
	const rewardStr = reward == null ? "—" : reward === 1 ? "PASS" : "FAIL";
	lines.push(
		`status=${status}  reward=${rewardStr}  turns=${totalTurns}  cost=${cost}  tokens=${tokens}`,
	);
	if (markers.length > 0) {
		lines.push("");
		lines.push(`markers: ${markers.join(", ")}`);
	}
	lines.push("");
	if (prompt) {
		lines.push("## Prompt");
		lines.push(summarize(prompt, 240));
		lines.push("");
	}
	lines.push("## Waterfall");
	for (const row of turnRows) {
		const upStatus = row.update?.status ?? "—";
		const upBody = row.update ? summarize(row.update.body, 80) : "(no update)";
		const upFail =
			row.update?.state === "failed" ? ` ✗ ${row.update.outcome ?? ""}` : "";
		lines.push(`T${row.turn}: ${upStatus}  "${upBody}"${upFail}`);
		for (const em of row.emissions) lines.push(renderEmission(em));
		for (const err of row.errors) lines.push(renderError(err));
	}
	lines.push("");
	lines.push("## Drill-down");
	lines.push("- agent/rummy.txt   (full trace)");
	lines.push("- agent/rummy.db    (sqlite — entries, run_views, turns)");
	lines.push("- reasoning.md      (per-turn reasoning_content)");
	return lines.join("\n");
}

function renderReasoning(taskName, turnRows) {
	const lines = [];
	lines.push(`# Reasoning: ${taskName}`);
	for (const row of turnRows) {
		lines.push("");
		lines.push(`## Turn ${row.turn}`);
		if (row.reasoning) {
			lines.push("");
			lines.push(row.reasoning);
		} else {
			lines.push("");
			lines.push("(no reasoning_content)");
		}
	}
	return lines.join("\n");
}

function digestJson({
	taskName,
	taskDir,
	prompt,
	runSummary,
	reward,
	turnRows,
	markers,
}) {
	return {
		task: taskName,
		dir: taskDir,
		reward,
		status: runSummary?.status ?? null,
		turns: runSummary?.turns ?? turnRows.length,
		tokens: runSummary?.tokens ?? null,
		cost: runSummary?.cost ?? null,
		wallSeconds: runSummary?.wallSeconds ?? null,
		markers,
		prompt: prompt ?? null,
		turnRows: turnRows.map((row) => ({
			turn: row.turn,
			totalTokens: row.totalTokens,
			reasoningChars: row.reasoningChars,
			update: row.update
				? {
						status: row.update.status,
						body: row.update.body,
						state: row.update.state,
						outcome: row.update.outcome,
					}
				: null,
			emissions: row.emissions.map((em) => ({
				action: em.action,
				targetPath: em.targetPath,
				visibility: em.visibility,
				state: em.state,
				outcome: em.outcome,
			})),
			errors: row.errors.map((err) => ({ body: err.body })),
		})),
	};
}

function processTask(taskDir) {
	const taskName = taskDir.split("/").pop().replace(/__[A-Za-z0-9]+$/, "");
	const rummyDb = join(taskDir, "agent", "rummy.db");
	if (!existsSync(rummyDb)) {
		closeSync(openSync(join(taskDir, "digest_skipped"), "w"));
		return {
			task: taskName,
			dir: taskDir,
			reward: readReward(taskDir),
			status: null,
			turns: 0,
			tokens: null,
			cost: null,
			wallSeconds: null,
			markers: ["exfil_fail"],
			prompt: null,
			turnRows: [],
		};
	}

	const reward = readReward(taskDir);
	const runSummary = readRunSummary(taskDir);
	const { turns, logEntries, prompt } = readDb(rummyDb);
	const turnRows = buildTurns(turns, logEntries);
	const markers = classifyMarkers(reward, runSummary, turnRows);

	const waterfall = renderWaterfall(
		taskName,
		prompt,
		runSummary,
		reward,
		turnRows,
		markers,
	);
	writeFileSync(join(taskDir, "digest.md"), `${waterfall}\n`);

	const reasoning = renderReasoning(taskName, turnRows);
	writeFileSync(join(taskDir, "reasoning.md"), `${reasoning}\n`);

	const digest = digestJson({
		taskName,
		taskDir,
		prompt,
		runSummary,
		reward,
		turnRows,
		markers,
	});
	writeFileSync(
		join(taskDir, "digest.json"),
		`${JSON.stringify(digest, null, 2)}\n`,
	);

	return digest;
}

function csvEscape(s) {
	if (s == null) return "";
	const str = String(s);
	if (/[,"\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

function writeIndex(sweepDir, digests) {
	const header = [
		"task",
		"reward",
		"status",
		"turns",
		"prompt_tokens",
		"completion_tokens",
		"cached_tokens",
		"cost",
		"wall_seconds",
		"markers",
	].join(",");
	const rows = digests
		.toSorted((a, b) => (a.task ?? "").localeCompare(b.task ?? ""))
		.map((d) =>
			[
				csvEscape(d.task),
				csvEscape(d.reward),
				csvEscape(d.status),
				csvEscape(d.turns),
				csvEscape(d.tokens?.prompt ?? ""),
				csvEscape(d.tokens?.completion ?? ""),
				csvEscape(d.tokens?.cached ?? ""),
				csvEscape(d.cost),
				csvEscape(d.wallSeconds),
				csvEscape(d.markers.join(";")),
			].join(","),
		);
	writeFileSync(join(sweepDir, "index.csv"), `${header}\n${rows.join("\n")}\n`);
}

// CLI: positional argument is a sweep dir or a task dir. With no
// argument, default to the latest sweep under test/tbench/results.
const target = process.argv[2];
let entry;
if (target) {
	entry = target.startsWith("/") ? target : join(process.cwd(), target);
} else {
	const sweeps = readdirSync(RESULTS_DIR)
		.filter((d) => statSync(join(RESULTS_DIR, d)).isDirectory())
		.sort();
	if (sweeps.length === 0) {
		console.error("no sweep dir found");
		process.exit(2);
	}
	entry = join(RESULTS_DIR, sweeps[sweeps.length - 1]);
}

if (!existsSync(entry)) {
	console.error(`not found: ${entry}`);
	process.exit(2);
}

if (isTaskDir(entry)) {
	const digest = processTask(entry);
	console.log(`wrote digest for ${digest.task}: ${digest.markers.join(", ")}`);
} else {
	const taskDirs = findTaskDirs(entry);
	if (taskDirs.length === 0) {
		console.error(`no task dirs (with agent/rummy.db) under ${entry}`);
		process.exit(2);
	}
	const digests = [];
	for (const td of taskDirs) {
		try {
			digests.push(processTask(td));
		} catch (err) {
			console.error(`! ${relative(entry, td)}: ${err.message}`);
			digests.push({
				task: td.split("/").pop().replace(/__[A-Za-z0-9]+$/, ""),
				dir: td,
				reward: null,
				status: null,
				turns: 0,
				tokens: null,
				cost: null,
				wallSeconds: null,
				markers: ["digest_failed"],
				prompt: null,
				turnRows: [],
			});
		}
	}
	writeIndex(entry, digests);
	console.log(
		`wrote ${digests.length} task digests + index.csv → ${entry}/index.csv`,
	);
}
