export default class Instructions {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("full", this.full.bind(this));
	}

	async full(entry) {
		const attrs = entry.attributes;
		let prompt = (entry.body || "").replace("[%TOOLS%]", attrs.tools || "");
		const toolDocs = await this.#core.hooks.instructions.toolDocs.filter(
			"",
			{},
		);
		if (toolDocs) prompt += `\n\n${toolDocs}`;
		if (attrs.persona) prompt += `\n\n## Persona\n\n${attrs.persona}`;
		return prompt;
	}
}
