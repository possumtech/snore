import docs from "./envDoc.js";

export default class Env {
	#core;

	constructor(core) {
		this.#core = core;
		// Same behavior as sh; different scheme name for ask-mode policy
		// differentiation (env is safe/read-only; sh has side effects).
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.env = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		await store.set({
			runId,
			turn,
			path: entry.resultPath,
			body: "",
			state: "proposed",
			attributes: { ...entry.attributes, summary: entry.attributes.command },
			loopId,
		});
	}

	full(entry) {
		return `# env ${entry.attributes.command}\n${entry.body}`;
	}

	summary() {
		return "";
	}
}
