import docs from "./summarizeDoc.js";

export default class Summarize {
	#core;

	constructor(core) {
		this.#core = core;
		core.ensureTool();
		core.registerScheme({ category: "logging" });
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.summarize = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const statusPath = await store.slugPath(runId, "summarize", entry.body);
		await store.upsert(runId, turn, statusPath, entry.body, 200, { loopId });
	}

	full(entry) {
		return `# summarize\n${entry.body}`;
	}

	summary(entry) {
		return this.full(entry);
	}
}
