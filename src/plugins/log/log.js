import { stateToStatus } from "../../agent/httpStatus.js";

// Schemes whose log-entry body is a small summary while the real
// content lives on the companion data entry — tokens= on these would
// point at the summary's size, not the action's cost.
const NO_TOKENS_SCHEMES = new Set(["set", "mv", "cp", "sh", "env"]);

export default class Log {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleLog.bind(this), 100);
	}

	async assembleLog(content, ctx) {
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
	// tools, else the entry's own DB path so update/search/rm/ask_user
	// surface meaningful identity instead of rendering path="".
	let target = "";
	if (attrs?.path) target = attrs.path;
	else if (attrs?.command) target = attrs.command;
	else if (entry.path) target = entry.path;
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
	const visibility = entry.visibility ? ` visibility="${entry.visibility}"` : "";
	const tokens =
		entry.tokens && !NO_TOKENS_SCHEMES.has(entry.scheme)
			? ` tokens="${entry.tokens}"`
			: "";
	const summary =
		typeof attrs?.summary === "string"
			? ` summary="${attrs.summary.slice(0, 80)}"`
			: "";

	const attrStr = `${turn}${status}${stateAttr}${outcomeAttr}${summary}${visibility}${tokens}`;

	if (entry.body) {
		return `<${entry.scheme} path="${target}"${attrStr}>${entry.body}</${entry.scheme}>`;
	}
	return `<${entry.scheme} path="${target}"${attrStr}/>`;
}
