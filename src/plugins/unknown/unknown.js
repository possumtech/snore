import { renderEntry, SUMMARY_MAX_CHARS } from "../helpers.js";

export default class Unknown {
	constructor(core) {
		core.ensureTool();
		core.registerScheme({
			category: "unknown",
		});
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("assembly.user", this.assembleUnknowns.bind(this), 150);
		// Hidden from the advertised tool list — the model writes unknowns
		// via <set path="unknown://..."/>. The unknown:// scheme lifecycle
		// is taught in instructions-user.md, not in a separate tooldoc.
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

		// tags > body for slug; lets the model round-trip via <get>.
		const unknownPath = await store.slugPath(
			runId,
			"unknown",
			entry.body,
			entry.attributes?.tags,
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

	// First SUMMARY_MAX_CHARS of the body. Matches <known> / <prompt>.
	summary(entry) {
		if (!entry.body) return "";
		return entry.body.slice(0, SUMMARY_MAX_CHARS);
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
	const meta = {};
	if (entry.source_turn) meta.turn = entry.source_turn;
	if (typeof attrs?.tags === "string") {
		meta.tags = attrs.tags.slice(0, 80);
	}
	if (entry.visibility) meta.visibility = entry.visibility;
	if (entry.aTokens != null) meta.tokens = entry.aTokens;
	return renderEntry(entry.path, meta, entry.body);
}
