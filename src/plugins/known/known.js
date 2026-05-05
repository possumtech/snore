import { stateToStatus } from "../../agent/httpStatus.js";
import { countTokens } from "../../agent/tokens.js";
import { renderEntry, SUMMARY_MAX_CHARS } from "../helpers.js";

const MAX_ENTRY_TOKENS = Number(process.env.RUMMY_MAX_ENTRY_TOKENS);

export default class Known {
	#core;

	constructor(core) {
		this.#core = core;
		core.ensureTool();
		core.registerScheme({ category: "data" });
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("assembly.user", this.assembleSummarized.bind(this), 50);
		core.filter("assembly.user", this.assembleVisible.bind(this), 75);
		// Hidden from the advertised tool list — written via <set path="known://...">.
		// The known:// scheme lifecycle is taught in instructions-user.md.
		core.markHidden();
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		if (!entry.body) return;

		const entryTokens = countTokens(entry.body);
		if (entryTokens > MAX_ENTRY_TOKENS) {
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath,
				body: `Entry too large (${entryTokens} tokens, max ${MAX_ENTRY_TOKENS}). Sort the information, ideas, or plans carefully into multiple entries.`,
				state: "failed",
				outcome: `overflow:${entryTokens}`,
			});
			return;
		}

		let knownPath = entry.attributes?.path;
		if (knownPath && !knownPath.includes("://")) {
			knownPath = `known://${knownPath}`;
		}
		if (!knownPath) {
			knownPath = await store.slugPath(
				runId,
				"known",
				entry.body,
				entry.attributes?.summary,
			);
		}

		// Dedup: existing path → update; empty body preserves existing body.
		const existing = await store.getEntriesByPattern(runId, knownPath, null);
		if (existing.length > 0) {
			const nextBody = entry.body === "" ? existing[0].body : entry.body;
			await store.set({
				runId,
				turn,
				path: existing[0].path,
				body: nextBody,
				state: "resolved",
				attributes: entry.attributes,
				loopId,
			});
			return;
		}

		await store.set({
			runId,
			turn,
			path: knownPath,
			body: entry.body,
			state: "resolved",
			attributes: entry.attributes,
			loopId,
		});
	}

	full(entry) {
		return entry.body;
	}

	// Summarized: first SUMMARY_MAX_CHARS of the body. The model already
	// knows summarized data is approximate (taught in instructions), so
	// we don't owe it a "[truncated]" marker that would push the body
	// past the contract floor.
	summary(entry) {
		if (!entry.body) return "";
		return entry.body.slice(0, SUMMARY_MAX_CHARS);
	}

	// Identity-keyed summary lines: every data entry the run is tracking
	// at visibility=visible or visibility=summarized.
	async assembleSummarized(content, ctx) {
		const entries = ctx.rows.filter(
			(r) =>
				r.category === "data" &&
				(r.visibility === "visible" || r.visibility === "summarized"),
		);
		if (entries.length === 0) return content;
		const lines = entries.map((e) =>
			renderContextTag(e, e.sBody != null ? e.sBody : e.body),
		);
		return `${content}<summarized>\n${lines.join("\n")}\n</summarized>\n`;
	}

	async assembleVisible(content, ctx) {
		const entries = ctx.rows.filter(
			(r) => r.category === "data" && r.visibility === "visible",
		);
		if (entries.length === 0) return content;
		const lines = entries.map((e) =>
			renderContextTag(e, e.vBody != null ? e.vBody : e.body),
		);
		return `${content}<visible>\n${lines.join("\n")}\n</visible>\n`;
	}
}

function renderContextTag(entry, projectedBody) {
	const attrs =
		typeof entry.attributes === "string"
			? JSON.parse(entry.attributes)
			: entry.attributes;
	const statusValue =
		attrs?.status != null
			? attrs.status
			: entry.state
				? stateToStatus(entry.state, entry.outcome)
				: null;
	const meta = {};
	if (entry.source_turn) meta.turn = entry.source_turn;
	if (statusValue != null && statusValue !== 200) meta.status = statusValue;
	if (entry.state && entry.state !== "resolved") meta.state = entry.state;
	if (entry.outcome) meta.outcome = entry.outcome;
	if (typeof attrs?.summary === "string") {
		meta.summary = attrs.summary.slice(0, 80);
	}
	if (entry.visibility === "archived") meta.visibility = "archived";
	if (entry.aTokens != null) meta.tokens = entry.aTokens;
	if (entry.vLines != null) meta.lines = entry.vLines;
	return renderEntry(entry.path, meta, projectedBody);
}
