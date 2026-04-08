import { readFileSync } from "node:fs";

export default class Unknown {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({
			category: "knowledge",
		});
		core.on("full", this.full.bind(this));
		core.filter("assembly.system", this.assembleUnknowns.bind(this), 300);
		const docs = readFileSync(new URL("./docs.md", import.meta.url), "utf8");
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.unknown = docs;
			return docsMap;
		});
	}

	full(entry) {
		return `# unknown\n${entry.body}`;
	}

	async assembleUnknowns(content, ctx) {
		const entries = ctx.rows.filter((r) => r.category === "unknown");
		if (entries.length === 0) return content;

		const lines = entries.map(
			(u) => `<unknown path="${u.path}">${u.body}</unknown>`,
		);
		return `${content}\n\n<unknowns>\n${lines.join("\n")}\n</unknowns>`;
	}
}
