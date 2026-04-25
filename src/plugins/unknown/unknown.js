export default class Unknown {
	#core;

	constructor(core) {
		this.#core = core;
		core.ensureTool();
		core.registerScheme({
			category: "unknown",
		});
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("assembly.user", this.assembleUnknowns.bind(this), 200);
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

	// Same principle as knowns: keep the first 500 characters on
	// summarized unknowns so demotion doesn't erase the question,
	// but cap large bodies to bound the packet cost.
	summary(entry) {
		if (!entry.body) return "";
		if (entry.body.length <= 500) return entry.body;
		return `${entry.body.slice(0, 500)}\n[truncated — promote to see the full question]`;
	}

	async assembleUnknowns(content, ctx) {
		const entries = ctx.rows.filter((r) => r.category === "unknown");
		if (entries.length === 0) return content;
		const lines = entries.map((e) => renderUnknownTag(e));
		return `${content}<unknowns>\n${lines.join("\n")}\n</unknowns>\n`;
	}
}

function renderUnknownTag(entry) {
	const attrs =
		typeof entry.attributes === "string"
			? JSON.parse(entry.attributes)
			: entry.attributes;
	const turn = entry.source_turn ? ` turn="${entry.source_turn}"` : "";
	const visibility = entry.visibility
		? ` visibility="${entry.visibility}"`
		: "";
	const tokens = entry.aTokens != null ? ` tokens="${entry.aTokens}"` : "";
	const summary =
		typeof attrs?.summary === "string"
			? ` summary="${attrs.summary.replace(/"/g, "'").slice(0, 80)}"`
			: "";
	const attrStr = `${turn}${summary}${visibility}${tokens}`;
	if (entry.body) {
		return `<unknown path="${entry.path}"${attrStr}>${entry.body}</unknown>`;
	}
	return `<unknown path="${entry.path}"${attrStr}/>`;
}
