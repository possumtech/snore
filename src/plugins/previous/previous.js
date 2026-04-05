import { renderHistoryEntry } from "../helpers.js";

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
				(r.category === "result" || r.category === "structural") &&
				r.source_turn < ctx.loopStartTurn,
		);
		if (entries.length === 0) return content;

		const lines = entries.map((e) => renderHistoryEntry(e));
		return `${content}\n\n<previous>\n${lines.join("\n")}\n</previous>`;
	}
}
