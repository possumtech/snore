import { storePatternResult } from "../helpers.js";

export default class Store {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId } = rummy;
		const target = entry.attributes.path;
		const bodyFilter = entry.attributes.body || null;
		const isPattern = bodyFilter || target.includes("*");
		const matches = await store.getEntriesByPattern(runId, target, bodyFilter);
		await store.demoteByPattern(runId, target, bodyFilter);

		if (isPattern) {
			await storePatternResult(
				store,
				runId,
				turn,
				"store",
				target,
				bodyFilter,
				matches,
			);
		} else {
			const paths = matches.map((m) => m.path).join(", ");
			const body =
				matches.length > 0 ? `${paths} stored` : `${target} not found`;
			await store.upsert(runId, turn, entry.resultPath, body, "stored");
		}
	}

	full(entry) {
		return `# store ${entry.attributes.path || entry.path}`;
	}
}
