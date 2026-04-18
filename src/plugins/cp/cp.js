import Repository from "../../agent/Repository.js";
import docs from "./cpDoc.js";

export default class Cp {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.cp = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const { path, to } = entry.attributes;
		const VALID = { promoted: 1, demoted: 1, archived: 1 };
		const fidelity = VALID[entry.attributes.fidelity]
			? entry.attributes.fidelity
			: undefined;

		const source = await store.getBody(runId, path);
		if (source === null) return;

		const destScheme = Repository.scheme(to);
		const existing = await store.getBody(runId, to);
		const warning =
			existing !== null && destScheme !== null
				? `Overwrote existing entry at ${to}`
				: null;

		const body = `${path} ${to}`;
		if (destScheme === null) {
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body,
				state: "proposed",
				attributes: { from: path, to, isMove: false, warning },
				loopId,
			});
		} else {
			await store.set({
				runId,
				turn,
				path: to,
				body: source,
				state: "resolved",
				fidelity,
				loopId,
			});
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body,
				state: "resolved",
				attributes: { from: path, to, isMove: false, warning },
				loopId,
			});
		}
	}

	full(entry) {
		return `# cp ${entry.attributes.from || ""} ${entry.attributes.to || ""}`;
	}

	summary() {
		return "";
	}
}
