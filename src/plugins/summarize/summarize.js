import { readFileSync } from "node:fs";

export default class Summarize {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({ category: "structural" });
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
		const docs = readFileSync(new URL("./docs.md", import.meta.url), "utf8");
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
