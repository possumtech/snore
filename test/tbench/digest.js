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

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");

const MAX_LOOP_TURNS = Number(process.env.RUMMY_MAX_LOOP_TURNS) || 99;
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

// Read all runs from a DB plus their per-run data. Tbench task DBs have
// exactly one run; e2e TestDb DBs have many (one per test invocation).
// The caller drives a per-run digest pass either way.
function readDb(rummyDb) {
	const db = new DatabaseSync(rummyDb, { readOnly: true });

	const runs = db.prepare("SELECT * FROM runs ORDER BY id").all();
	const turnsStmt = db.prepare(
		`SELECT sequence, total_tokens, prompt_tokens, completion_tokens,
		        cached_tokens, reasoning_tokens, reasoning_content
		 FROM turns
		 WHERE run_id = ?
		 ORDER BY sequence`,
	);
	const logStmt = db.prepare(
		`SELECT e.path, e.body, e.attributes, e.scheme,
		        rv.state, rv.outcome, rv.visibility, rv.turn
		 FROM entries e
		 JOIN run_views rv ON rv.entry_id = e.id
		 WHERE rv.run_id = ?
		   AND e.path LIKE 'log://turn_%'
		 ORDER BY e.id`,
	);
	const promptStmt = db.prepare(
		`SELECT e.body
		 FROM entries e
		 JOIN run_views rv ON rv.entry_id = e.id
		 WHERE rv.run_id = ? AND e.path = 'prompt://1'
		 LIMIT 1`,
	);
	// Per-turn assembled packet bytes. system://N + user://N are what we
	// sent to the LLM; assistant://N is the parsed content; model://N is
	// the raw response wrapper (includes reasoning_content, finish_reason,
	// usage). reasoning://N is the bare reasoning channel when the model
	// surfaced one.
	const packetStmt = db.prepare(
		`SELECT e.path, e.body
		 FROM entries e
		 JOIN run_views rv ON rv.entry_id = e.id
		 WHERE rv.run_id = ?
		   AND (e.path GLOB 'system://*' OR e.path GLOB 'user://*'
		        OR e.path GLOB 'assistant://*' OR e.path GLOB 'model://*'
		        OR e.path GLOB 'reasoning://*')
		 ORDER BY e.id`,
	);

	const perRun = runs.map((run) => ({
		run,
		turns: turnsStmt.all(run.id),
		logEntries: logStmt.all(run.id),
		packetEntries: packetStmt.all(run.id),
		prompt: promptStmt.get(run.id)?.body ?? null,
	}));

	db.close();
	return perRun;
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
	if (reward === 0 && status === 200)
		markers.push("claim_success_verifier_fail");
	if (status === 499 && turnRows.length >= MAX_LOOP_TURNS - 1) {
		markers.push("max_loop_turns");
	}
	if (status === 413) markers.push("context_overflow");
	if (status === 500) markers.push("dispatch_500");

	let strikeAbandon = false;
	let runawayTurn = null;
	let parserWarn = false;
	for (const row of turnRows) {
		const stuck =
			row.reasoningChars >= REASONING_RUNAWAY_CHARS &&
			row.emissions.length === 0 &&
			!row.update;
		if (stuck) runawayTurn = row.turn;
		for (const err of row.errors) {
			const body = err.body || "";
			if (body.startsWith("Abandoned after")) strikeAbandon = true;
			if (body.startsWith("Unclosed") || body.includes("Tool call limit")) {
				parserWarn = true;
			}
		}
	}
	if (strikeAbandon) markers.push("strike_abandon");
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

function renderWaterfall(
	taskName,
	prompt,
	runSummary,
	reward,
	turnRows,
	markers,
) {
	const lines = [];
	lines.push(`# ${taskName}`);
	lines.push("");
	const status = runSummary?.status ?? "?";
	const totalTurns = runSummary?.turns ?? turnRows.length;
	const cost =
		runSummary?.cost != null ? `$${runSummary.cost.toFixed(4)}` : "?";
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
	lines.push("- packets.md        (per-turn assembled wire packets)");
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

// Group packet entries (system://N / user://N / assistant://N / model://N
// / reasoning://N) by their turn number suffix.
function groupPacketsByTurn(packetEntries) {
	const byTurn = new Map();
	for (const e of packetEntries) {
		const m = e.path.match(/^([a-z]+):\/\/(\d+)$/);
		if (!m) continue;
		const role = m[1];
		const turn = Number(m[2]);
		if (!byTurn.has(turn)) byTurn.set(turn, {});
		byTurn.get(turn)[role] = e.body;
	}
	return [...byTurn.entries()]
		.toSorted(([a], [b]) => a - b)
		.map(([turn, parts]) => ({ turn, ...parts }));
}

// Per-turn packet dump: exactly what was sent (system + user) and
// received (assistant + model wrapper + reasoning) for each turn. The
// shape mirrors the wire payload so a forensic reader can see how
// errors, log entries, and state actually presented to the model.
function renderPackets(taskName, turnPackets) {
	const lines = [];
	lines.push(`# Packets: ${taskName}`);
	lines.push("");
	lines.push(
		"Per-turn assembled packets. `system` + `user` are the outgoing message;",
	);
	lines.push(
		"`assistant` is the parsed completion; `model` is the raw response",
	);
	lines.push("wrapper (usage, finish_reason); `reasoning` is the bare CoT");
	lines.push("channel when the provider surfaces one.");
	for (const p of turnPackets) {
		lines.push("");
		lines.push(`## Turn ${p.turn}`);
		for (const role of ["system", "user", "assistant", "reasoning", "model"]) {
			if (p[role] == null) continue;
			lines.push("");
			lines.push(`### ${role}://${p.turn}`);
			lines.push("");
			lines.push("```");
			lines.push(p[role]);
			lines.push("```");
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

// Synthesize a run-summary from the DB for runs that lack the harbor-side
// rummy.txt `__RUMMY_RUN_SUMMARY__` line (e2e tests, primarily). Token
// counts come from the turns table; status from the runs table.
function synthSummary(run, turnsRows) {
	let prompt = 0;
	let completion = 0;
	let cached = 0;
	let reasoning = 0;
	for (const t of turnsRows) {
		prompt += t.prompt_tokens || 0;
		completion += t.completion_tokens || 0;
		cached += t.cached_tokens || 0;
		reasoning += t.reasoning_tokens || 0;
	}
	return {
		status: run.status ?? null,
		turns: turnsRows.length,
		tokens: { prompt, completion, cached, reasoning },
		cost: 0,
		wallSeconds: null,
	};
}

function processTask(taskDir) {
	const taskName = taskDir
		.split("/")
		.pop()
		.replace(/__[A-Za-z0-9]+$/, "");
	const rummyDb = join(taskDir, "agent", "rummy.db");
	if (!existsSync(rummyDb)) {
		closeSync(openSync(join(taskDir, "digest_skipped"), "w"));
		return [
			{
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
			},
		];
	}

	const reward = readReward(taskDir);
	const harborSummary = readRunSummary(taskDir);
	const perRun = readDb(rummyDb);

	// Tbench DBs hold one run per task container; e2e TestDb DBs hold many
	// (one per `it()` block). Single-run task dirs keep the legacy layout
	// (digest.md alongside agent/); multi-run task dirs nest per-run output
	// at <task>/<alias>/.
	const multiRun = perRun.length > 1;
	const out = [];
	for (const { run, turns, logEntries, packetEntries, prompt } of perRun) {
		const turnRows = buildTurns(turns, logEntries);
		const turnPackets = groupPacketsByTurn(packetEntries);
		const runSummary =
			!multiRun && harborSummary ? harborSummary : synthSummary(run, turns);
		const markers = classifyMarkers(reward, runSummary, turnRows);
		const runName = multiRun ? `${taskName}/${run.alias}` : taskName;
		const outDir = multiRun ? join(taskDir, run.alias) : taskDir;
		mkdirSync(outDir, { recursive: true });

		const waterfall = renderWaterfall(
			runName,
			prompt,
			runSummary,
			reward,
			turnRows,
			markers,
		);
		writeFileSync(join(outDir, "digest.md"), `${waterfall}\n`);
		writeFileSync(
			join(outDir, "reasoning.md"),
			`${renderReasoning(runName, turnRows)}\n`,
		);
		writeFileSync(
			join(outDir, "packets.md"),
			`${renderPackets(runName, turnPackets)}\n`,
		);
		const digest = digestJson({
			taskName: runName,
			taskDir: outDir,
			prompt,
			runSummary,
			reward,
			turnRows,
			markers,
		});
		writeFileSync(
			join(outDir, "digest.json"),
			`${JSON.stringify(digest, null, 2)}\n`,
		);
		out.push(digest);
	}
	return out;
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
	const digests = processTask(entry);
	for (const d of digests) {
		console.log(`wrote digest for ${d.task}: ${d.markers.join(", ")}`);
	}
} else {
	const taskDirs = findTaskDirs(entry);
	if (taskDirs.length === 0) {
		console.error(`no task dirs (with agent/rummy.db) under ${entry}`);
		process.exit(2);
	}
	const digests = [];
	for (const td of taskDirs) {
		try {
			digests.push(...processTask(td));
		} catch (err) {
			console.error(`! ${relative(entry, td)}: ${err.message}`);
			digests.push({
				task: td
					.split("/")
					.pop()
					.replace(/__[A-Za-z0-9]+$/, ""),
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
		`wrote ${digests.length} digests + index.csv → ${entry}/index.csv`,
	);
}
