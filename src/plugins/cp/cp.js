import KnownStore from "../../agent/KnownStore.js";

export default class Cp {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId } = rummy;
		const { path, to } = entry.attributes;

		const source = await store.getBody(runId, path);
		if (source === null) return;

		const destScheme = KnownStore.scheme(to);
		const existing = await store.getBody(runId, to);
		const warning =
			existing !== null && destScheme !== null
				? `Overwrote existing entry at ${to}`
				: null;

		const body = `${path} ${to}`;
		if (destScheme === null) {
			await store.upsert(runId, turn, entry.resultPath, body, "proposed", {
				attributes: { from: path, to, isMove: false, warning },
			});
		} else {
			await store.upsert(runId, turn, to, source, "full");
			await store.upsert(runId, turn, entry.resultPath, body, "pass", {
				attributes: { from: path, to, isMove: false, warning },
			});
		}
	}

	full(entry) {
		return `# cp ${entry.attributes.from || ""} ${entry.attributes.to || ""}`;
	}
}
