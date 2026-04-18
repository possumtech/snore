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

	const target = attrs?.path || attrs?.command || "";
	const turn = entry.source_turn ? ` turn="${entry.source_turn}"` : "";
	const status = entry.state
		? ` status="${stateToStatus(entry.state, entry.outcome)}"`
		: "";
	const fidelity = entry.fidelity ? ` fidelity="${entry.fidelity}"` : "";
	const tokens = entry.tokens ? ` tokens="${entry.tokens}"` : "";
	const summary =
		typeof attrs?.summary === "string"
			? ` summary="${attrs.summary.slice(0, 80)}"`
			: "";

	const body = entry.body || null;

	if (body) {
		return `<${entry.scheme} path="${target}"${turn}${status}${summary}${fidelity}${tokens}>${body}</${entry.scheme}>`;
	}
	return `<${entry.scheme} path="${target}"${turn}${status}${summary}${fidelity}${tokens}/>`;
}
