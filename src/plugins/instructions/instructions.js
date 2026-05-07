import { readFileSync } from "node:fs";
import Protocol from "./protocol.js";

const baseInstructions = readFileSync(
	new URL("./instructions-system.md", import.meta.url),
	"utf8",
);

// Tight, non-modal reminder rendered LATE in the user message
// (`assembly.user` priority 165, between unknowns at 150 and budget at
// 175) so the rules sit adjacent to the action site — recency keeps the
// per-turn discipline warm. The user message is a sandwich: prompt at
// front (cacheable across turns of a run), state in the middle, rules
// then budget at the back.
const userInstructions = readFileSync(
	new URL("./instructions-user.md", import.meta.url),
	"utf8",
).trim();

const TURN_FROM_PATH = /^log:\/\/turn_(\d+)\/update\//;

export default class Instructions {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("visible", this.full.bind(this));
		core.on("turn.started", this.onTurnStarted.bind(this));
		core.hooks.instructions.resolveSystemPrompt =
			this.resolveSystemPrompt.bind(this);
		core.hooks.instructions.findLatestSummary =
			this.findLatestSummary.bind(this);
		core.filter("assembly.user", this.assembleInstructions.bind(this), 165);
		new Protocol(core);
	}

	// Render the user-side reminder right before the prompt block. Single
	// file, no mode keying — same content every turn.
	assembleInstructions(content, _ctx) {
		return `${content}<instructions>\n${userInstructions}\n</instructions>\n`;
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

	// Latest terminal update (status=200) — used by cli.js to print the
	// run's final answer. State-machine knowledge lives here, not AgentLoop.
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

	async onTurnStarted({ rummy }) {
		const { entries: store, sequence: turn, runId } = rummy;
		const runRow = await store.getRun(runId);
		const toolSet = rummy.toolSet
			? [...rummy.toolSet]
			: this.#core.hooks.tools.names;
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
		// Tools list shown to the model — advertised only.
		const advertised = this.#core.hooks.tools.advertisedNames.filter((n) =>
			activeTools.has(n),
		);
		const tools = advertised.map((n) => `<${n}/>`).join(", ");
		// Tooldoc render — every registered tool with a doc, advertised or
		// hidden. Hidden tools (unknown, known) don't appear in the list
		// but their scheme lifecycle still needs teaching.
		const all = this.#core.hooks.tools.names.filter((n) => activeTools.has(n));
		const docsText = all
			.filter((key) => toolDocs[key])
			.map((key) => toolDocs[key])
			.join("\n\n");
		let prompt = baseInstructions
			.replace("[%TOOLS%]", tools)
			.replace("[%TOOLDOCS%]", docsText);
		prompt += `\n\n## Operational Persona\n\n${attrs.persona}`;
		return prompt;
	}
}
