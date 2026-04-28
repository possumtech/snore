import { stateToStatus } from "../../agent/httpStatus.js";
import { countTokens } from "../../agent/tokens.js";

const MAX_ENTRY_TOKENS = Number(process.env.RUMMY_MAX_ENTRY_TOKENS);

export default class Known {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({ category: "data" });
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("assembly.user", this.assembleSummarized.bind(this), 50);
		core.filter("assembly.user", this.assembleVisible.bind(this), 75);
		// Hidden tool: written via <set path="known://...">; handler tolerates direct <known>.
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

	// Summarized: first 500 chars; matches <prompt> summarized.
	summary(entry) {
		if (!entry.body) return "";
		if (entry.body.length <= 500) return entry.body;
		return `${entry.body.slice(0, 500)}\n[truncated — promote to see the full body]`;
	}

	// Identity-keyed summary lines: every data entry the run is tracking
	// at visibility=visible or visibility=summarized. Archived prompts pass
	// through as the named carve-out (active prompt must remain discoverable).
	async assembleSummarized(content, ctx) {
		const entries = ctx.rows.filter(
			(r) =>
				r.category === "data" &&
				(r.visibility === "visible" ||
					r.visibility === "summarized" ||
					(r.visibility === "archived" && r.scheme === "prompt")),
		);
		if (entries.length === 0) return content;
		const lines = entries.map(renderSummaryLine);
		return `${content}<summarized>\n${lines.join("\n")}\n</summarized>\n`;
	}

	// Working-set bodies: only entries currently promoted to visible.
	async assembleVisible(content, ctx) {
		const entries = ctx.rows.filter(
			(r) => r.category === "data" && r.visibility === "visible",
		);
		if (entries.length === 0) return content;
		const lines = entries.map(renderVisibleBody);
		return `${content}<visible>\n${lines.join("\n")}\n</visible>\n`;
	}
}

function entryAttrs(entry) {
	const turn =
		entry.source_turn != null ? ` turn="${entry.source_turn}"` : "";
	const tokens = entry.aTokens != null ? ` tokens="${entry.aTokens}"` : "";
	const lines = entry.vLines != null ? ` lines="${entry.vLines}"` : "";
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
	const status =
		statusValue != null && statusValue !== 200
			? ` status="${statusValue}"`
			: "";
	const stateAttr =
		entry.state && entry.state !== "resolved" ? ` state="${entry.state}"` : "";
	const outcomeAttr = entry.outcome ? ` outcome="${entry.outcome}"` : "";
	const summaryText =
		typeof attrs?.summary === "string"
			? attrs.summary.replace(/"/g, "'").slice(0, 80)
			: "";
	const summary = ` summary="${summaryText}"`;
	const visibility =
		entry.visibility === "archived" ? ` visibility="archived"` : "";
	return `${turn}${status}${stateAttr}${outcomeAttr}${summary}${visibility}${tokens}${lines}`;
}

function renderSummaryLine(entry) {
	const tag = entry.scheme ? entry.scheme : "file";
	return `<${tag} path="${entry.path}"${entryAttrs(entry)}/>`;
}

function renderVisibleBody(entry) {
	const tag = entry.scheme ? entry.scheme : "file";
	const a = entryAttrs(entry);
	if (entry.body) {
		return `<${tag} path="${entry.path}"${a}>${entry.body}</${tag}>`;
	}
	return `<${tag} path="${entry.path}"${a}/>`;
}
