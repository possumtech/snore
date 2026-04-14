import docs from "./shDoc.js";

export default class Sh {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.sh = docs;
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
		return `# sh ${entry.attributes.command || ""}\n${entry.body}`;
	}

	summary() {
		return "";
	}
}
