import Repository from "../../agent/Repository.js";
import docs from "./mvDoc.js";

export default class Mv {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.mv = docs;
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

		// Fidelity-in-place: no destination, change visibility of matched entries
		if (fidelity && !to) {
			const matches = await store.getEntriesByPattern(runId, path);
			for (const match of matches)
				await store.set({ runId: runId, path: match.path, fidelity: fidelity });
			const label = `set to ${fidelity}`;
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: `${matches.map((m) => m.path).join(", ")} ${label}`,
				state: "resolved",
				fidelity: "archived",
				loopId,
			});
			return;
		}

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
				attributes: { from: path, to, isMove: true, warning },
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
			await store.rm({ runId: runId, path: path });
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body,
				state: "resolved",
				attributes: { from: path, to, isMove: true, warning },
				loopId,
			});
		}
	}

	full(entry) {
		return `# mv ${entry.attributes.from} ${entry.attributes.to}`;
	}

	summary() {
		return "";
	}
}
