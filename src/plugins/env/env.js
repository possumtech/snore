export default class Env {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId } = rummy;
		await store.upsert(runId, turn, entry.resultPath, entry.body, "pass", {
			attributes: entry.attributes,
		});
	}

	full(entry) {
		return `# env ${entry.attributes.command || ""}\n${entry.body}`;
	}
}
