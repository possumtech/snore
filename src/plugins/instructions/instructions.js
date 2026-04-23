import { readFileSync } from "node:fs";
import Protocol from "./protocol.js";

const preamble = readFileSync(
	new URL("./preamble.md", import.meta.url),
	"utf8",
);

const PHASES = [4, 5, 6, 7, 8];
const phasePreambles = Object.fromEntries(
	PHASES.map((p) => [
		p,
		readFileSync(
			new URL(`./preamble_10${p}.md`, import.meta.url),
			"utf8",
		).trim(),
	]),
);
const VALID_STATUSES = new Set([
	144, 145, 155, 156, 166, 167, 177, 178, 188, 200,
]);
const TURN_FROM_PATH = /^log:\/\/turn_(\d+)\/update\//;

function phaseForStatus(status) {
	if (status == null) return 4;
	if (status === 200) return 8;
	const last = status % 10;
	return PHASES.includes(last) ? last : 4;
}

async function latestUpdateStatus(store, runId) {
	const entries = await store.getEntriesByPattern(runId, "log://**", null);
	let bestTurn = -1;
	let bestStatus = null;
	for (const e of entries) {
		const m = TURN_FROM_PATH.exec(e.path);
		if (!m) continue;
		const turn = Number(m[1]);
		const attrs =
			typeof e.attributes === "string"
				? JSON.parse(e.attributes)
				: e.attributes;
		const status = attrs?.status;
		if (!VALID_STATUSES.has(status)) continue;
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
		const protocolStatus = await latestUpdateStatus(store, runId);
		// instructions:// is an audit scheme (writable_by: ["system"]).
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
				protocolStatus,
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
		const step = phasePreambles[phaseForStatus(attrs.protocolStatus)];
		let prompt = preamble
			.replace("[%TOOLS%]", tools)
			.replace("[%PROTOCOL_STEP%]", step)
			.replace("[%TOOLDOCS%]", docsText);
		if (attrs.persona) prompt += `\n\n## Persona\n\n${attrs.persona}`;
		return prompt;
	}
}
