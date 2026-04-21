export default class Unknown {
	#core;

	constructor(core) {
		this.#core = core;
		core.ensureTool();
		core.registerScheme({
			category: "unknown",
		});
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.markHidden();
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;

		// Deduplicate — if this exact body already exists, skip
		const existingValues = await store.getUnknownValues(runId);
		if (existingValues.has(entry.body)) {
			await this.#core.hooks.error.log.emit({
				store,
				runId,
				turn,
				loopId,
				message: `Unknown deduped: "${entry.body.slice(0, 60)}"`,
			});
			return;
		}

		// Generate slug path and upsert. Summary (if provided) becomes the
		// path so the model can round-trip it via <get>; body is the fallback.
		const unknownPath = await store.slugPath(
			runId,
			"unknown",
			entry.body,
			entry.attributes?.summary,
		);
		await store.set({
			runId,
			turn,
			path: unknownPath,
			body: entry.body,
			state: "resolved",
			loopId,
		});
	}

	full(entry) {
		return entry.body;
	}

	summary() {
		return "";
	}
}
