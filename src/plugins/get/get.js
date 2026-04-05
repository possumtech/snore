import { storePatternResult } from "../helpers.js";

export default class Get {
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
		await store.promoteByPattern(runId, target, bodyFilter, turn);

		if (isPattern) {
			await storePatternResult(
				store,
				runId,
				turn,
				"get",
				target,
				bodyFilter,
				matches,
			);
		} else {
			const total = matches.reduce((s, m) => s + m.tokens_full, 0);
			const paths = matches.map((m) => m.path).join(", ");
			const body =
				matches.length > 0 ? `${paths} ${total} tokens` : `${target} not found`;
			await store.upsert(runId, turn, entry.resultPath, body, "read");
		}
	}

	full(entry) {
		return `# get ${entry.attributes.path || entry.path}\n${entry.body}`;
	}
}
