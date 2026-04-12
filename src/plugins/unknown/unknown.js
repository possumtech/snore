import docs from "./unknownDoc.js";

export default class Unknown {
	#core;

	constructor(core) {
		this.#core = core;
		core.ensureTool();
		core.registerScheme({
			category: "unknown",
		});
		core.on("full", this.full.bind(this));
		core.filter("assembly.system", this.assembleUnknowns.bind(this), 300);
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.unknown = docs;
			return docsMap;
		});
	}

	full(entry) {
		return `# unknown\n${entry.body}`;
	}

	summary(entry) {
		return this.full(entry);
	}

	async assembleUnknowns(content, ctx) {
		const entries = ctx.rows.filter((r) => r.category === "unknown");
		if (entries.length === 0) return content;

		const lines = entries.map((u) => {
			const fidelity = u.fidelity ? ` fidelity="${u.fidelity}"` : "";
			const tokens = u.tokens ? ` tokens="${u.tokens}"` : "";
			return `<unknown path="${u.path}" turn="${u.source_turn || u.turn}"${fidelity}${tokens}>${u.body}</unknown>`;
		});
		return `${content}\n\n<unknowns>\n${lines.join("\n")}\n</unknowns>`;
	}
}
