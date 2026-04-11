import KnownStore from "../../agent/KnownStore.js";
import docs from "./cpDoc.js";

export default class Cp {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.cp = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const { path, to } = entry.attributes;
		const VALID = { stored: 1, summary: 1, index: 1, full: 1, archive: 1 };
		const fidelity = VALID[entry.attributes.fidelity]
			? entry.attributes.fidelity
			: undefined;

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
			await store.upsert(runId, turn, entry.resultPath, body, 202, {
				attributes: { from: path, to, isMove: false, warning },
				loopId,
			});
		} else {
			await store.upsert(runId, turn, to, source, 200, { fidelity, loopId });
			await store.upsert(runId, turn, entry.resultPath, body, 200, {
				attributes: { from: path, to, isMove: false, warning },
				loopId,
			});
		}
	}

	full(entry) {
		return `# cp ${entry.attributes.from || ""} ${entry.attributes.to || ""}`;
	}

	summary(entry) {
		return this.full(entry);
	}
}
