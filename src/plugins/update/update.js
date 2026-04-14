import docs from "./updateDoc.js";

export default class Update {
	#core;

	constructor(core) {
		this.#core = core;
		core.ensureTool();
		core.registerScheme({ category: "logging" });
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.update = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const statusPath = await store.slugPath(runId, "update", entry.body);
		await store.upsert(runId, turn, statusPath, entry.body, 200, { loopId });
	}

	full(entry) {
		return `# update\n${entry.body}`;
	}

	summary(entry) {
		return this.full(entry);
	}
}
