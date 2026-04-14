import { countTokens } from "../../agent/tokens.js";
import docs from "./knownDoc.js";

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
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.known = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		if (!entry.body) return;

		// Size gate
		const entryTokens = countTokens(entry.body);
		if (entryTokens > MAX_ENTRY_TOKENS) {
			const rejectPath = await store.slugPath(runId, "known", entry.body);
			await store.upsert(
				runId,
				turn,
				rejectPath,
				`Entry too large (${entryTokens} tokens, max ${MAX_ENTRY_TOKENS}). Sort the information, ideas, or plans carefully into multiple entries.`,
				413,
				{ loopId },
			);
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
			await store.upsert(
				runId,
				turn,
				existing[0].path,
				entry.body || existing[0].body,
				200,
				{ attributes: entry.attributes, loopId },
			);
			return;
		}

		await store.upsert(runId, turn, knownPath, entry.body, 200, {
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

		// Rows arrive pre-sorted by SQL: summary → full, then by recency
		const demotedSet = new Set(ctx.demoted || []);
		const lines = entries.map((e) => renderKnownTag(e, demotedSet));
		return `${content}\n\n<knowns>\n${lines.join("\n")}\n</knowns>`;
	}
}

function renderKnownTag(entry, demotedSet) {
	const tag = entry.scheme || "file";
	const turn = entry.source_turn ? ` turn="${entry.source_turn}"` : "";
	const tokens = entry.tokens ? ` tokens="${entry.tokens}"` : "";
	const status = entry.status ? ` status="${entry.status}"` : "";
	const fidelity = entry.fidelity ? ` fidelity="${entry.fidelity}"` : "";
	const flag = demotedSet?.has(entry.path) ? " demoted" : "";

	const attrs =
		typeof entry.attributes === "string"
			? JSON.parse(entry.attributes)
			: entry.attributes;
	const summary =
		typeof attrs?.summary === "string"
			? ` summary="${attrs.summary.replace(/"/g, "'").slice(0, 80)}"`
			: "";

	if (entry.body) {
		return `<${tag} path="${entry.path}"${turn}${status}${summary}${fidelity}${tokens}${flag}>${entry.body}</${tag}>`;
	}
	return `<${tag} path="${entry.path}"${turn}${status}${summary}${fidelity}${tokens}${flag}/>`;
}
