import { existsSync, readFileSync } from "node:fs";
import Protocol from "./protocol.js";

const baseInstructions = readFileSync(
	new URL("./instructions.md", import.meta.url),
	"utf8",
);

// 1XY phase routing; see plugin README.
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

// Latest non-rejected update status from materialized rows.
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
		if (attrs?.rejected) continue;
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
		core.hooks.instructions.validateNavigation =
			this.validateNavigation.bind(this);
		core.hooks.instructions.findLatestSummary =
			this.findLatestSummary.bind(this);
		core.filter("assembly.user", this.assembleInstructions.bind(this), 250);
		new Protocol(core);
	}

	// Project instructions://system through the visible view; called once per turn.
	async resolveSystemPrompt(rummy) {
		const { entries: store, runId, hooks } = rummy;
		const entries = await store.getEntriesByPattern(
			runId,
			"instructions://system",
			null,
			{ includeAuditSchemes: true },
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

	// Reject illegal stage navigation; see plugin README.
	async validateNavigation(status, rummy) {
		const currentPhase = await this.#getCurrentPhase(rummy);
		const nextPhase = phaseForStatus(status);
		if (nextPhase > currentPhase + 1) {
			return { ok: false, reason: "Illegal navigation attempt" };
		}
		if (status === 200 && currentPhase !== 7) {
			return { ok: false, reason: "Illegal navigation attempt" };
		}
		if (nextPhase === 7) {
			const visible = await this.#countVisiblePriorPrompts(rummy);
			if (visible > 0) {
				return {
					ok: false,
					reason: `Illegal navigation attempt: ${visible} visible prior prompts`,
				};
			}
		}
		return { ok: true };
	}

	async #getCurrentPhase(rummy) {
		// `**` not `*`: update slugs may contain URL-encoded `/`.
		const updates = await rummy.entries.getEntriesByPattern(
			rummy.runId,
			"log://*/update/**",
			null,
		);
		let bestTurn = -1;
		let bestStatus = null;
		for (const e of updates) {
			const m = TURN_FROM_PATH.exec(e.path);
			if (!m) continue;
			const turn = Number(m[1]);
			if (turn >= rummy.sequence) continue;
			const attrs =
				typeof e.attributes === "string"
					? JSON.parse(e.attributes)
					: e.attributes;
			if (attrs?.rejected) continue;
			if (attrs?.status == null) continue;
			if (turn > bestTurn) {
				bestTurn = turn;
				bestStatus = attrs.status;
			}
		}
		return phaseForStatus(bestStatus);
	}

	// Latest phase-7 success (status=200); state-machine knowledge lives here, not AgentLoop.
	findLatestSummary(logEntries) {
		return logEntries
			.filter((e) => {
				if (!TURN_FROM_PATH.test(e.path)) return false;
				const attrs =
					typeof e.attributes === "string"
						? JSON.parse(e.attributes)
						: e.attributes;
				return attrs?.status === 200;
			})
			.at(-1);
	}

	async #countVisiblePriorPrompts(rummy) {
		const prompts = await rummy.entries.getEntriesByPattern(
			rummy.runId,
			"prompt://*",
			null,
		);
		const visible = prompts.filter((p) => p.visibility === "visible");
		if (visible.length === 0) return 0;
		// Exclude the latest prompt; only PRIOR prompts trigger demote-before-Deployment.
		let maxNum = -1;
		for (const p of visible) {
			const m = /^prompt:\/\/(\d+)$/.exec(p.path);
			if (m && Number(m[1]) > maxNum) maxNum = Number(m[1]);
		}
		return visible.filter((p) => {
			const m = /^prompt:\/\/(\d+)$/.exec(p.path);
			return !m || Number(m[1]) !== maxNum;
		}).length;
	}

	async onTurnStarted({ rummy }) {
		const { entries: store, sequence: turn, runId } = rummy;
		const runRow = await store.getRun(runId);
		const toolSet = rummy.toolSet
			? [...rummy.toolSet]
			: this.#core.hooks.tools.names;
		// instructions://system stays cache-stable; phase selection at assembly.user.
		await store.set({
			runId,
			turn,
			path: "instructions://system",
			body: "",
			state: "resolved",
			writer: "system",
			attributes: {
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

	// Render <instructions> for current phase; absent phase file → no block.
	assembleInstructions(content, ctx) {
		const status = latestUpdateStatusFromRows(ctx.rows);
		const step = phaseInstructions[phaseForStatus(status)];
		if (!step) return content;
		return `${content}<instructions>\n${step}\n</instructions>\n`;
	}
}
