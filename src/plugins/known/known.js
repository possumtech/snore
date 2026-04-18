import { stateToStatus } from "../../agent/httpStatus.js";
import { countTokens } from "../../agent/tokens.js";

const MAX_ENTRY_TOKENS = Number(process.env.RUMMY_MAX_ENTRY_TOKENS) || 512;

export default class Known {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({ category: "data" });
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.filter("assembly.system", this.assembleKnown.bind(this), 100);
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
		let knownPath = entry.attributes?.path || null;
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

		// Dedup: if path exists, update rather than duplicate
		const existing = await store.getEntriesByPattern(runId, knownPath, null);
		if (existing.length > 0) {
			await store.set({
				runId,
				turn,
				path: existing[0].path,
				body: entry.body || existing[0].body,
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

	async assembleKnown(content, ctx) {
		const entries = ctx.rows.filter((r) => r.category === "data");
		if (entries.length === 0) return content;

		// Rows arrive pre-sorted by SQL: demoted → promoted, then by recency
		const demotedSet = new Set(ctx.demoted || []);
		const lines = entries.map((e) => renderKnownTag(e, demotedSet));
		return `${content}\n\n<knowns>\n${lines.join("\n")}\n</knowns>`;
	}
}

function renderKnownTag(entry, demotedSet) {
	const tag = entry.scheme || "file";
	const turn = entry.source_turn ? ` turn="${entry.source_turn}"` : "";
	const tokens = entry.tokens ? ` tokens="${entry.tokens}"` : "";
	const status = entry.state
		? ` status="${stateToStatus(entry.state, entry.outcome)}"`
		: "";
	const fidelity = entry.fidelity ? ` fidelity="${entry.fidelity}"` : "";
	const flag = demotedSet?.has(entry.path) ? " demoted" : "";

	const attrs =
		typeof entry.attributes === "string"
			? JSON.parse(entry.attributes)
			: entry.attributes;
	// Always render summary attribute on knowns — empty value hints the model
	// it forgot to add searchable keywords.
	const summaryText =
		typeof attrs?.summary === "string"
			? attrs.summary.replace(/"/g, "'").slice(0, 80)
			: "";
	const summary = ` summary="${summaryText}"`;

	if (entry.body) {
		return `<${tag} path="${entry.path}"${turn}${status}${summary}${fidelity}${tokens}${flag}>${entry.body}</${tag}>`;
	}
	return `<${tag} path="${entry.path}"${turn}${status}${summary}${fidelity}${tokens}${flag}/>`;
}
