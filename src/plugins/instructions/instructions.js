import { existsSync, readFileSync } from "node:fs";
import Protocol from "./protocol.js";

const baseInstructions = readFileSync(
	new URL("./instructions.md", import.meta.url),
	"utf8",
);

// 1XY status encoding: X=current phase, Y=next phase. Y routes through
// phaseForStatus to select next turn's <instructions>. Phases 4–9 are
// reserved (status codes 1X4..1X9); add new phases by dropping in
// `instructions_10N.md`. Absent files render no <instructions> block —
// the model runs on base instructions only. This lets you route ahead
// of writing the prose (e.g. an upcoming "ask lite" phase 9).
const PHASES = [4, 5, 6, 7, 8, 9];
const phaseInstructions = Object.fromEntries(
	PHASES.flatMap((p) => {
		const url = new URL(`./instructions_10${p}.md`, import.meta.url);
		return existsSync(url) ? [[p, readFileSync(url, "utf8").trim()]] : [];
	}),
);
const TURN_FROM_PATH = /^log:\/\/turn_(\d+)\/update\//;

function phaseForStatus(status) {
	if (status == null) return 4;
	if (status === 200) return 7;
	const last = status % 10;
	return PHASES.includes(last) ? last : 4;
}

// Scan an already-materialized row set for the most recent update
// emission's status. Used by the assembly.user filter so the phase
// instructions ride with the user message (dynamic, expected to
// change every turn) instead of the system prompt (stable, cached).
// Validation is upstream (update.js isValidStatus + 422 error log) so
// we trust the status and route on it directly — a whitelist here
// silently drops advertised completion codes whose contracts drift,
// which is worse than a noisy fallback.
function latestUpdateStatusFromRows(rows) {
	let bestTurn = -1;
	let bestStatus = null;
	for (const r of rows) {
		const m = TURN_FROM_PATH.exec(r.path);
		if (!m) continue;
		const turn = Number(m[1]);
		const attrs =
			typeof r.attributes === "string"
				? JSON.parse(r.attributes)
				: r.attributes;
		const status = attrs?.status;
		if (status == null) continue;
		if (turn > bestTurn || (turn === bestTurn && status > bestStatus)) {
			bestTurn = turn;
			bestStatus = status;
		}
	}
	return bestStatus;
}

export default class Instructions {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("visible", this.full.bind(this));
		core.on("turn.started", this.onTurnStarted.bind(this));
		core.hooks.instructions.resolveSystemPrompt =
			this.resolveSystemPrompt.bind(this);
		// Dynamic phase instructions live in the user message (above
		// <prompt>) so the system message stays cache-stable across turns.
		// Priority 250 puts us between <log> (100), <unknowns> (200),
		// and <prompt> (300).
		core.filter("assembly.user", this.assembleInstructions.bind(this), 250);
		new Protocol(core);
	}

	/**
	 * Materialize the system prompt for a run: look up the
	 * instructions://system entry, project it through the promoted view.
	 * TurnExecutor calls this once per turn before context assembly.
	 */
	async resolveSystemPrompt(rummy) {
		const { entries: store, runId, hooks } = rummy;
		const entries = await store.getEntriesByPattern(
			runId,
			"instructions://system",
			null,
		);
		// The entry is always written by onTurnStarted before this runs.
		const entry = entries[0];
		const attributes = await store.getAttributes(
			runId,
			"instructions://system",
		);
		return hooks.tools.view("instructions", {
			path: "instructions://system",
			scheme: "instructions",
			body: entry.body,
			attributes,
			visibility: "visible",
			category: "system",
		});
	}

	async onTurnStarted({ rummy }) {
		const { entries: store, sequence: turn, runId } = rummy;
		const runRow = await store.getRun(runId);
		const toolSet = rummy.toolSet
			? [...rummy.toolSet]
			: this.#core.hooks.tools.names;
		// instructions:// is an audit scheme (writable_by: ["system"]).
		// No per-turn phase state on this entry — keeps the system
		// prompt cache-stable across turns. Phase selection happens at
		// assembly.user time from the current row set.
		await store.set({
			runId,
			turn,
			path: "instructions://system",
			body: "",
			state: "resolved",
			writer: "system",
			attributes: {
				// runRow.persona is a nullable TEXT column; absent row is
				// a system bug — let the null propagate if runRow exists.
				persona: runRow.persona,
				toolSet,
			},
		});
	}

	async full(entry) {
		const attrs = entry.attributes;
		const activeTools = attrs.toolSet
			? new Set(attrs.toolSet)
			: new Set(this.#core.hooks.tools.names);
		const toolDocs = await this.#core.hooks.instructions.toolDocs.filter(
			{},
			{ toolSet: activeTools },
		);
		// Hidden tools are excluded at the registry level (see ToolRegistry).
		const sorted = this.#core.hooks.tools.advertisedNames.filter((n) =>
			activeTools.has(n),
		);
		const tools = sorted.map((n) => `<${n}/>`).join(", ");
		const docsText = sorted
			.filter((key) => toolDocs[key])
			.map((key) => toolDocs[key])
			.join("\n\n");
		let prompt = baseInstructions
			.replace("[%TOOLS%]", tools)
			.replace("[%TOOLDOCS%]", docsText);
		if (attrs.persona) prompt += `\n\n## Persona\n\n${attrs.persona}`;
		return prompt;
	}

	// Renders the current phase's instructions as an <instructions>
	// block in the user message. Runs at priority 250 — after <log>
	// and <unknowns>, immediately before <prompt>. System prompt stays
	// static so prompt caching keeps its prefix intact across turns.
	// A routed phase without an instructions_10N.md file emits nothing —
	// the model proceeds on base instructions alone.
	assembleInstructions(content, ctx) {
		const status = latestUpdateStatusFromRows(ctx.rows);
		const step = phaseInstructions[phaseForStatus(status)];
		if (!step) return content;
		return `${content}<instructions>\n${step}\n</instructions>\n`;
	}
}
