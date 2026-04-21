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
		// <known> is internal — written via <set path="known://...">. Hidden
		// from all model-facing tool lists. Handler still dispatches if the
		// model emits <known> directly out of habit.
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

		// Resolve path: explicit or auto-generated slug
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

		// Dedup: if path exists, update rather than duplicate. An empty
		// new body means "preserve the existing entry's body" (e.g. the
		// model is updating attributes only).
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

	summary() {
		return "";
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
	// schemeOf() returns NULL / "" for bare file paths; translate for the tag.
	const tag = entry.scheme ? entry.scheme : "file";
	const turn = entry.source_turn ? ` turn="${entry.source_turn}"` : "";
	const tokens = entry.tokens ? ` tokens="${entry.tokens}"` : "";
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
	const status = statusValue != null ? ` status="${statusValue}"` : "";
	const stateAttr =
		entry.state && entry.state !== "resolved" ? ` state="${entry.state}"` : "";
	const outcomeAttr = entry.outcome ? ` outcome="${entry.outcome}"` : "";
	const visibility = entry.visibility ? ` visibility="${entry.visibility}"` : "";
	const flag = demotedSet?.has(entry.path) ? " demoted" : "";
	// Always render summary attribute on knowns — empty value hints the model
	// it forgot to add searchable keywords.
	const summaryText =
		typeof attrs?.summary === "string"
			? attrs.summary.replace(/"/g, "'").slice(0, 80)
			: "";
	const summary = ` summary="${summaryText}"`;

	const attrStr = `${turn}${status}${stateAttr}${outcomeAttr}${summary}${visibility}${tokens}${flag}`;
	if (entry.body) {
		return `<${tag} path="${entry.path}"${attrStr}>${entry.body}</${tag}>`;
	}
	return `<${tag} path="${entry.path}"${attrStr}/>`;
}
