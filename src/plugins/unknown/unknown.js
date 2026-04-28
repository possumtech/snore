export default class Unknown {
	constructor(core) {
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

		const existingValues = await store.getUnknownValues(runId);
		if (existingValues.has(entry.body)) {
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath || entry.path,
				body: `Unknown deduped: "${entry.body.slice(0, 60)}"`,
				state: "failed",
				outcome: "duplicate",
			});
			return;
		}

		// summary > body for slug; lets the model round-trip via <get>.
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

	// First 500 chars; matches knowns/prompt summarized.
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
