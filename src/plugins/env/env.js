import docs from "./envDoc.js";

export default class Env {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.env = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		await store.upsert(runId, turn, entry.resultPath, entry.body, 202, {
			attributes: entry.attributes,
			loopId,
		});
	}

	full(entry) {
		return `# env ${entry.attributes.command || ""}\n${entry.body}`;
	}

	summary() {
		return "";
	}
}
