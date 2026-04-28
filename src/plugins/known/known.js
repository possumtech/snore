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
		core.filter("assembly.system", this.assembleContext.bind(this), 100);
		// Hidden tool: written via <set path="known://...">; handler tolerates direct <known>.
		core.markHidden();
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		if (!entry.body) return;

		// Size gate
		const entryTokens = countTokens(entry.body);
		if (entryTokens > MAX_ENTRY_TOKENS) {
			const rejectPath = await store.slugPath(runId, "known", entry.body);
			await store.set({
				runId,
				turn,
				path: rejectPath,
				body: `Entry too large (${entryTokens} tokens, max ${MAX_ENTRY_TOKENS}). Sort the information, ideas, or plans carefully into multiple entries.`,
				state: "failed",
				outcome: `overflow:${entryTokens}`,
				loopId,
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

	async assembleContext(content, ctx) {
		const entries = ctx.rows.filter((r) => r.category === "data");
		if (entries.length === 0) return content;
		const demotedSet = new Set(ctx.demoted);
		const lines = entries.map((e) => renderContextTag(e, demotedSet));
		return `${content}\n\n<context>\n${lines.join("\n")}\n</context>`;
	}
}

function renderContextTag(entry, demotedSet) {
	const tag = entry.scheme ? entry.scheme : "file";
	const turn = entry.source_turn ? ` turn="${entry.source_turn}"` : "";
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
	const visibility = entry.visibility
		? ` visibility="${entry.visibility}"`
		: "";
	const flag = demotedSet?.has(entry.path) ? " demoted" : "";
	// Always emit summary; empty value hints the model to add keywords.
	const summaryText =
		typeof attrs?.summary === "string"
			? attrs.summary.replace(/"/g, "'").slice(0, 80)
			: "";
	const summary = ` summary="${summaryText}"`;

	const attrStr = `${turn}${status}${stateAttr}${outcomeAttr}${summary}${visibility}${tokens}${lines}${flag}`;
	if (entry.body) {
		return `<${tag} path="${entry.path}"${attrStr}>${entry.body}</${tag}>`;
	}
	return `<${tag} path="${entry.path}"${attrStr}/>`;
}
