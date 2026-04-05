export default class Unknown {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("full", this.full.bind(this));
	}

	full(entry) {
		return `# unknown\n${entry.body}`;
	}
}
