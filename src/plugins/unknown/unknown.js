export default class Unknown {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("full", this.full.bind(this));
		core.filter("assembly.system", this.assembleUnknowns.bind(this), 300);
	}

	full(entry) {
		return `# unknown\n${entry.body}`;
	}

	async assembleUnknowns(content, ctx) {
		const entries = ctx.rows.filter((r) => r.category === "unknown");
		if (entries.length === 0) return content;

		const lines = entries.map((u) => `* ${u.body}`);
		return `${content}\n\n<unknowns>\n${lines.join("\n")}\n</unknowns>`;
	}
}
