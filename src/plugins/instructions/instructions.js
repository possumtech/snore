import { readFileSync } from "node:fs";

const preamble = readFileSync(
	new URL("./preamble.md", import.meta.url),
	"utf8",
);

export default class Instructions {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("full", this.full.bind(this));
		core.on("turn.started", this.onTurnStarted.bind(this));
	}

	async onTurnStarted({ rummy }) {
		const { entries: store, sequence: turn, runId } = rummy;
		const runRow = await rummy.db.get_run_by_id.get({ id: runId });
		const toolSet = rummy.toolSet
			? [...rummy.toolSet]
			: this.#core.hooks.tools.names;
		await store.upsert(runId, turn, "instructions://system", "", 200, {
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
		const tools = [...activeTools].join(", ");
		let prompt = preamble.replace("[%TOOLS%]", tools);
		const toolDocs = await this.#core.hooks.instructions.toolDocs.filter(
			{},
			{ toolSet: activeTools },
		);
		const docsText = Object.entries(toolDocs)
			.filter(([key]) => activeTools.has(key))
			.map(([, value]) => value)
			.join("\n\n");
		if (docsText) prompt += `\n\n${docsText}`;
		if (attrs.persona) prompt += `\n\n## Persona\n\n${attrs.persona}`;
		return prompt;
	}
}
