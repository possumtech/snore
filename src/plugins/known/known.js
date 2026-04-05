import { FIDELITY_ORDER, langFor } from "../helpers.js";

export default class Known {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.filter("assembly.system", this.assembleKnown.bind(this), 100);
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId } = rummy;
		const target = entry.attributes.path || entry.resultPath;
		await store.upsert(runId, turn, target, entry.body, "full");
	}

	full(entry) {
		return `# known ${entry.path}\n${entry.body}`;
	}

	async assembleKnown(content, ctx) {
		const entries = ctx.rows.filter(
			(r) =>
				r.category === "file" ||
				r.category === "file_index" ||
				r.category === "known" ||
				r.category === "known_index",
		);
		if (entries.length === 0) return content;

		entries.sort((a, b) => {
			const fa = FIDELITY_ORDER[a.fidelity] ?? 0;
			const fb = FIDELITY_ORDER[b.fidelity] ?? 0;
			if (fa !== fb) return fa - fb;
			if (a.category < b.category) return -1;
			if (a.category > b.category) return 1;
			return 0;
		});

		const lines = entries.map((e) => renderKnowledgeEntry(e));
		return `${content}\n\n<known>\n${lines.join("\n")}\n</known>`;
	}
}

function renderKnowledgeEntry(entry) {
	if (entry.category === "file_index" || entry.category === "known_index") {
		return entry.path;
	}
	if (entry.category === "known") {
		return `* ${entry.path} — ${entry.body}`;
	}
	if (entry.category === "file") {
		const lang = langFor(entry.path);
		const tokens = entry.tokens ? ` (${entry.tokens} tokens)` : "";
		const attrs =
			typeof entry.attributes === "string"
				? JSON.parse(entry.attributes)
				: entry.attributes;
		const constraint = attrs?.constraint;
		const label =
			constraint === "readonly"
				? " (readonly)"
				: constraint === "active"
					? " (active)"
					: "";
		return `#### ${entry.path}${tokens}${label}\n\`\`\`${lang}\n${entry.body}\n\`\`\``;
	}
	return `* ${entry.path} — ${entry.body}`;
}
