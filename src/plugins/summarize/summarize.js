export default class Summarize {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("full", this.full.bind(this));
	}

	full(entry) {
		return `# summarize\n${entry.body}`;
	}
}
