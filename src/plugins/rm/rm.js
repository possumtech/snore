export default class Rm {
	#rummy;

	constructor(rummy) {
		this.#rummy = rummy;
		rummy.on("handler", this.handler.bind(this));
		rummy.on("full", this.full.bind(this));
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId } = rummy;
		const target = entry.attributes.path;
		const matches = await store.getEntriesByPattern(
			runId,
			target,
			entry.attributes.body,
		);

		for (const match of matches) {
			const resultPath = `rm://${match.path}`;
			if (match.scheme === null) {
				await store.upsert(runId, turn, resultPath, match.path, "proposed", {
					attributes: { path: match.path },
				});
			} else {
				await store.remove(runId, match.path);
				await store.upsert(runId, turn, resultPath, match.path, "pass", {
					attributes: { path: match.path },
				});
			}
		}
	}

	full(entry) {
		return `# rm ${entry.attributes.path || entry.path}`;
	}
}
