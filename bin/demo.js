#!/usr/bin/env node
// Fast inspector for the most recent (or a named) run.
//
// Pulls the packet the model actually saw (system://N, user://N), the
// model's response (assistant://N, reasoning://N), the log entries for
// the turn, and optional summaries across the whole run.
//
// Usage:
//   npm run test:demo                  # latest run, latest turn
//   npm run test:demo -- --turn 5      # latest run, turn 5
//   npm run test:demo -- --run alias   # specific run, its latest turn
//   npm run test:demo -- --all         # all turns' headers + final packet
//   npm run test:demo -- --packet      # only dump system/user/assistant

import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const args = parseArgs({
	options: {
		run: { type: "string" },
		turn: { type: "string" },
		all: { type: "boolean", default: false },
		packet: { type: "boolean", default: false },
		db: { type: "string", default: "rummy_dev.db" },
	},
	allowPositionals: false,
}).values;

const db = new DatabaseSync(args.db);

const runRow = args.run
	? db.prepare("SELECT * FROM runs WHERE alias = ?").get(args.run)
	: db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get();

if (!runRow) {
	console.error(args.run ? `run ${args.run} not found` : "no runs in db");
	process.exit(1);
}

const runId = runRow.id;
const alias = runRow.alias;

const turns = db
	.prepare(
		"SELECT sequence, context_tokens, prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, cost FROM turns WHERE run_id = ? ORDER BY sequence",
	)
	.all(runId);

const selectedTurn = args.turn ? Number(args.turn) : turns.at(-1)?.sequence;

const banner = (s) => console.log(`\n━━━ ${s} ${"━".repeat(Math.max(4, 70 - s.length))}`);

const loadBody = (path) => {
	const row = db
		.prepare(
			"SELECT e.body, e.attributes, rv.state, rv.outcome, rv.visibility FROM entries e JOIN run_views rv ON rv.entry_id = e.id WHERE rv.run_id = ? AND e.path = ?",
		)
		.get(runId, path);
	return row ? row : null;
};

// ── header ─────────────────────────────────────────────────────────
const totalCost = turns.reduce((s, t) => s + (t.cost || 0), 0);
banner(`run ${alias}  (id=${runId}, status=${runRow.status})`);
console.log(
	`model=${runRow.model}  turns=${turns.length}  cost=${totalCost.toFixed(6)}`,
);

if (!args.packet) {
	banner("turns");
	for (const t of turns) {
		const marker = t.sequence === selectedTurn ? "▶" : " ";
		console.log(
			`${marker} turn ${String(t.sequence).padStart(2)}  ctx=${String(t.context_tokens).padStart(6)}  in=${String(t.prompt_tokens).padStart(6)}  out=${String(t.completion_tokens).padStart(5)}  reason=${String(t.reasoning_tokens).padStart(5)}`,
		);
	}
}

// ── packet for the selected turn ───────────────────────────────────
if (selectedTurn) {
	const system = loadBody(`system://${selectedTurn}`);
	const user = loadBody(`user://${selectedTurn}`);
	const assistant = loadBody(`assistant://${selectedTurn}`);
	const reasoning = loadBody(`reasoning://${selectedTurn}`);

	banner(`turn ${selectedTurn} — system://`);
	console.log(system ? system.body : "(not recorded)");
	banner(`turn ${selectedTurn} — user://`);
	console.log(user ? user.body : "(not recorded)");
	banner(`turn ${selectedTurn} — assistant://`);
	console.log(assistant ? assistant.body : "(not recorded)");
	if (reasoning) {
		banner(`turn ${selectedTurn} — reasoning://`);
		console.log(reasoning.body);
	}
}

if (args.packet) process.exit(0);

// ── log entries for the selected turn ──────────────────────────────
if (selectedTurn) {
	banner(`turn ${selectedTurn} — log entries`);
	const logs = db
		.prepare(
			"SELECT e.path, e.body, e.attributes, rv.state, rv.outcome, rv.visibility FROM entries e JOIN run_views rv ON rv.entry_id = e.id WHERE rv.run_id = ? AND rv.turn = ? AND e.path LIKE 'log://%' ORDER BY e.id",
		)
		.all(runId, selectedTurn);
	if (logs.length === 0) console.log("(none)");
	for (const l of logs) {
		const attrs = l.attributes ? JSON.parse(l.attributes) : {};
		const body = l.body ? l.body.replace(/\n/g, "⏎").slice(0, 100) : "";
		console.log(
			`  ${l.state.padEnd(9)} ${l.visibility.padEnd(10)} ${l.path}`,
		);
		if (Object.keys(attrs).length > 0)
			console.log(`    attrs: ${JSON.stringify(attrs).slice(0, 200)}`);
		if (body) console.log(`    body:  ${body}`);
	}
}

// ── unresolved (proposals awaiting client) ─────────────────────────
banner("unresolved");
const pending = db
	.prepare(
		"SELECT e.path, substr(e.attributes,1,200) AS attrs, rv.turn FROM entries e JOIN run_views rv ON rv.entry_id = e.id WHERE rv.run_id = ? AND rv.state IN ('proposed','streaming') ORDER BY e.id",
	)
	.all(runId);
if (pending.length === 0) console.log("(none)");
for (const p of pending) console.log(`  turn ${p.turn}  ${p.path}\n    ${p.attrs}`);

// ── unknowns + knowns tally ────────────────────────────────────────
const unknowns = db
	.prepare(
		"SELECT e.path, e.body FROM entries e JOIN run_views rv ON rv.entry_id = e.id WHERE rv.run_id = ? AND e.scheme = 'unknown' ORDER BY e.id",
	)
	.all(runId);
banner(`unknowns (${unknowns.length})`);
for (const u of unknowns)
	console.log(`  ${u.path}\n    ${u.body.slice(0, 120)}`);

const knowns = db
	.prepare(
		"SELECT e.path FROM entries e JOIN run_views rv ON rv.entry_id = e.id WHERE rv.run_id = ? AND e.scheme = 'known' ORDER BY e.id",
	)
	.all(runId);
banner(`knowns (${knowns.length})`);
for (const k of knowns) console.log(`  ${k.path}`);

// ── all turns (if --all) ───────────────────────────────────────────
if (args.all) {
	for (const t of turns) {
		if (t.sequence === selectedTurn) continue;
		const system = loadBody(`system://${t.sequence}`);
		const user = loadBody(`user://${t.sequence}`);
		const assistant = loadBody(`assistant://${t.sequence}`);
		banner(`turn ${t.sequence} — system://`);
		console.log(system ? system.body : "(not recorded)");
		banner(`turn ${t.sequence} — user://`);
		console.log(user ? user.body : "(not recorded)");
		banner(`turn ${t.sequence} — assistant://`);
		console.log(assistant ? assistant.body : "(not recorded)");
	}
}

db.close();
