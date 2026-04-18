import { readFileSync } from "node:fs";

const preamble = readFileSync(
	new URL("./preamble.md", import.meta.url),
	"utf8",
);

export default class Instructions {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("promoted", this.full.bind(this));
		core.on("turn.started", this.onTurnStarted.bind(this));
		core.hooks.instructions.resolveSystemPrompt =
			this.resolveSystemPrompt.bind(this);
	}

	/**
	 * Materialize the system prompt for a run: look up the
	 * instructions://system entry, project it through the promoted view.
	 * TurnExecutor calls this once per turn before context assembly.
	 */
	async resolveSystemPrompt(runId) {
		const store = this.#core.entries;
		const entries = await store.getEntriesByPattern(
			runId,
			"instructions://system",
			null,
		);
		const attributes = entries[0]
			? await store.getAttributes(runId, "instructions://system")
			: null;
		return this.#core.hooks.tools.view("instructions", {
			path: "instructions://system",
			scheme: "instructions",
			body: entries[0]?.body || "",
			attributes,
			fidelity: "promoted",
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
		await store.upsert(runId, turn, "instructions://system", "", 200, {
			writer: "system",
			attributes: {
				persona: runRow?.persona || null,
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
		const tools = sorted.join(", ");
		const docsText = sorted
			.filter((key) => toolDocs[key])
			.map((key) => toolDocs[key])
			.join("\n\n");
		let prompt = preamble
			.replace("[%TOOLS%]", tools)
			.replace("[%TOOLDOCS%]", docsText);
		if (attrs.persona) prompt += `\n\n## Persona\n\n${attrs.persona}`;
		return prompt;
	}
}
