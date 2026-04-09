import docs from "./summarizeDoc.js";

export default class Summarize {
	#core;

	constructor(core) {
		this.#core = core;
		core.ensureTool();
		core.registerScheme({ category: "logging" });
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.summarize = docs;
			return docsMap;
		});
	}

	full(entry) {
		return `# summarize\n${entry.body}`;
	}

	summary(entry) {
		return this.full(entry);
	}
}
