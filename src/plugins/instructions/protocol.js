export default class Protocol {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("entry.recording", this.#onRecording.bind(this), 1);
	}

	async #onRecording(entry, _ctx) {
		return entry;
	}
}
