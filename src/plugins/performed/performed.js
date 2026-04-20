import { stateToStatus } from "../../agent/httpStatus.js";

export default class Performed {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assemblePerformed.bind(this), 100);
	}

	async assemblePerformed(content, ctx) {
		const entries = ctx.rows.filter(
			(r) =>
				r.category === "logging" &&
				r.source_turn >= ctx.loopStartTurn &&
				r.scheme !== "unknown",
		);
		if (entries.length === 0) return content;

		const lines = entries.map((e) => renderToolTag(e));
		return `${content}<performed>\n${lines.join("\n")}\n</performed>\n`;
	}
}

function renderToolTag(entry) {
	const attrs =
		typeof entry.attributes === "string"
			? JSON.parse(entry.attributes)
			: entry.attributes;

	// Display target: attrs.path for store tools, attrs.command for shell
	// tools, empty for schemes that have neither.
	let target = "";
	if (attrs?.path) target = attrs.path;
	else if (attrs?.command) target = attrs.command;
	const turn = entry.source_turn ? ` turn="${entry.source_turn}"` : "";
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
	const fidelity = entry.fidelity ? ` fidelity="${entry.fidelity}"` : "";
	const tokens = entry.tokens ? ` tokens="${entry.tokens}"` : "";
	const summary =
		typeof attrs?.summary === "string"
			? ` summary="${attrs.summary.slice(0, 80)}"`
			: "";

	const attrStr = `${turn}${status}${stateAttr}${outcomeAttr}${summary}${fidelity}${tokens}`;

	if (entry.body) {
		return `<${entry.scheme} path="${target}"${attrStr}>${entry.body}</${entry.scheme}>`;
	}
	return `<${entry.scheme} path="${target}"${attrStr}/>`;
}
