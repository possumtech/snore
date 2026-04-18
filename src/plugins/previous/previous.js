import { stateToStatus } from "../../agent/httpStatus.js";

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

	const target = attrs?.path || attrs?.command || "";
	const turn = entry.source_turn ? ` turn="${entry.source_turn}"` : "";
	const status = entry.state
		? ` status="${stateToStatus(entry.state, entry.outcome)}"`
		: "";
	const fidelity = entry.fidelity ? ` fidelity="${entry.fidelity}"` : "";
	const tokens = entry.tokens ? ` tokens="${entry.tokens}"` : "";
	const summary =
		typeof attrs?.summary === "string"
			? ` summary="${attrs.summary.replace(/"/g, "'")}"`
			: "";

	// Trust the projected body. Plugin decided per-fidelity what to show.
	if (entry.body) {
		return `<${entry.scheme} path="${target}"${turn}${status}${summary}${fidelity}${tokens}>${entry.body}</${entry.scheme}>`;
	}
	return `<${entry.scheme} path="${target}"${turn}${status}${summary}${fidelity}${tokens}/>`;
}
