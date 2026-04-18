import docs from "./envDoc.js";

export default class Env {
	#core;

	constructor(core) {
		this.#core = core;
		// Same behavior as sh; different scheme name for ask-mode policy
		// differentiation (env is safe/read-only; sh has side effects).
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
		const command = entry.attributes.command || entry.body || "";
		await store.upsert(runId, turn, entry.resultPath, "", "proposed", {
			attributes: { ...entry.attributes, summary: command },
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
