export default class Known {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId } = rummy;
		const target = entry.attributes.path || entry.resultPath;
		await store.upsert(runId, turn, target, entry.body, "full");
	}

	full(entry) {
		return `# known ${entry.path}\n${entry.body}`;
	}
}
