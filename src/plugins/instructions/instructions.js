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
		await store.upsert(runId, turn, "instructions://system", "", 200, {
			attributes: { persona: runRow?.persona || null },
		});
	}

	async full(entry) {
		const attrs = entry.attributes;
		const tools = this.#core.hooks.tools.names.join(", ");
		let prompt = preamble.replace("[%TOOLS%]", tools);
		const toolDocs = await this.#core.hooks.instructions.toolDocs.filter(
			"",
			{},
		);
		if (toolDocs) prompt += `\n\n${toolDocs}`;
		if (attrs.persona) prompt += `\n\n## Persona\n\n${attrs.persona}`;
		return prompt;
	}
}
