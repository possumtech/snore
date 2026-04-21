import { stateToStatus } from "../../agent/httpStatus.js";

// Schemes whose log-entry body is a small summary while the "real"
// content lives on a data entry produced as a side effect. A `tokens=`
// attribute on these log tags advertises the summary's size, which the
// model reads as the action's cost — a mixed signal. Drop it.
const NO_TOKENS_SCHEMES = new Set(["set", "mv", "cp", "sh", "env"]);

export default class Log {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleLog.bind(this), 100);
	}

	async assembleLog(content, ctx) {
		// Every logging-category entry across the entire run, ordered by
		// v_model_context's sort (category → recency). No loop-boundary
		// split — the `turn` attribute on each entry carries when it
		// happened; the model derives loop membership from the data.
		const entries = ctx.rows.filter((r) => r.category === "logging");
		if (entries.length === 0) return content;

		const lines = entries.map((e) => renderLogTag(e));
		return `${content}<log>\n${lines.join("\n")}\n</log>\n`;
	}
}

function renderLogTag(entry) {
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
	const tokens =
		entry.tokens && !NO_TOKENS_SCHEMES.has(entry.scheme)
			? ` tokens="${entry.tokens}"`
			: "";
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
