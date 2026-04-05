export default class Update {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("full", this.full.bind(this));
	}

	full(entry) {
		return `# update\n${entry.body}`;
	}
}
