export default class Previous {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.system", this.assemblePrevious.bind(this), 200);
	}

	async assemblePrevious(content, ctx) {
		if (ctx.loopStartTurn <= 1) return content;

		const entries = ctx.rows.filter(
			(r) =>
				(r.category === "logging" || r.category === "prompt") &&
				r.source_turn < ctx.loopStartTurn,
		);
		if (entries.length === 0) return content;

		const lines = await Promise.all(
			entries.map((e) => renderToolTag(e, this.#core)),
		);
		return `${content}\n\n<previous>\n${lines.join("\n")}\n</previous>`;
	}
}

async function renderToolTag(entry, _core) {
	const attrs =
		typeof entry.attributes === "string"
			? JSON.parse(entry.attributes)
			: entry.attributes;

	const target = attrs?.path || attrs?.file || attrs?.command || "";
	const turn = entry.source_turn ? ` turn="${entry.source_turn}"` : "";
	const status = entry.status ? ` status="${entry.status}"` : "";
	const fidelity = entry.fidelity ? ` fidelity="${entry.fidelity}"` : "";
	const tokens = entry.tokens ? ` tokens="${entry.tokens}"` : "";

	// Previous entries render at summary. Prompts get 512 chars for orientation.
	const limit = entry.scheme === "prompt" ? 512 : 80;
	const rawSummary =
		(typeof attrs?.summary === "string" ? attrs.summary : null) ||
		entry.body?.slice(0, limit) ||
		"";
	// Strip internal dedup namespace prefixes (e.g. "get://turn_3/src/app.js" → "src/app.js")
	const summaryText = rawSummary.replace(/\b\w+:\/\/turn_\d+\//g, "");
	const summaryAttr = summaryText
		? ` summary="${summaryText.replace(/"/g, "'").slice(0, limit)}"`
		: "";

	return `<${entry.scheme} path="${target}"${turn}${status}${summaryAttr}${fidelity}${tokens}/>`;
}
