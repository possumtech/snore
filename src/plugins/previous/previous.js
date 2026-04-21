import { stateToStatus } from "../../agent/httpStatus.js";

// Schemes whose log-entry body is a small summary while the "real"
// content lives on a data entry produced as a side effect. A `tokens=`
// attribute on these log tags advertises the summary's size, which the
// model reads as the action's cost — a mixed signal. Drop it.
const NO_TOKENS_SCHEMES = new Set(["set", "mv", "cp", "sh", "env"]);

export default class Previous {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.system", this.assemblePrevious.bind(this), 200);
	}

	async assemblePrevious(content, ctx) {
		if (ctx.loopStartTurn <= 1) return content;

		const entries = ctx.rows
			.filter(
				(r) =>
					(r.category === "logging" || r.category === "prompt") &&
					r.source_turn < ctx.loopStartTurn,
			)
			.toSorted((a, b) => {
				if (a.source_turn !== b.source_turn)
					return a.source_turn - b.source_turn;
				// Within the same turn: prompt first (cause before effect)
				if (a.category === "prompt" && b.category !== "prompt") return -1;
				if (b.category === "prompt" && a.category !== "prompt") return 1;
				return 0;
			});
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
			? ` summary="${attrs.summary.replace(/"/g, "'")}"`
			: "";

	const attrStr = `${turn}${status}${stateAttr}${outcomeAttr}${summary}${fidelity}${tokens}`;
	if (entry.body) {
		return `<${entry.scheme} path="${target}"${attrStr}>${entry.body}</${entry.scheme}>`;
	}
	return `<${entry.scheme} path="${target}"${attrStr}/>`;
}
