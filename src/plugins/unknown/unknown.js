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
		core.filter("assembly.system", this.assembleUnknowns.bind(this), 300);
		// <unknown> is internal — written via <set path="unknown://...">. Hidden
		// from all model-facing tool lists. Handler still dispatches if the
		// model emits <unknown> directly out of habit.
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
		await store.upsert(runId, turn, unknownPath, entry.body, 200, { loopId });
	}

	full(entry) {
		return entry.body;
	}

	summary() {
		return "";
	}

	async assembleUnknowns(content, ctx) {
		const entries = ctx.rows.filter((r) => r.category === "unknown");
		if (entries.length === 0) return content;

		const lines = entries.map((u) => {
			const fidelity = u.fidelity ? ` fidelity="${u.fidelity}"` : "";
			const tokens = u.tokens ? ` tokens="${u.tokens}"` : "";
			if (u.body) {
				return `<unknown path="${u.path}" turn="${u.source_turn || u.turn}"${fidelity}${tokens}>${u.body}</unknown>`;
			}
			return `<unknown path="${u.path}" turn="${u.source_turn || u.turn}"${fidelity}${tokens}/>`;
		});
		return `${content}\n\n<unknowns>\n${lines.join("\n")}\n</unknowns>`;
	}
}
