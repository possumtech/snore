import { renderHistoryEntry } from "../helpers.js";

export default class Current {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleCurrent.bind(this), 100);
	}

	async assembleCurrent(content, ctx) {
		const entries = ctx.rows.filter(
			(r) =>
				(r.category === "result" || r.category === "structural") &&
				r.source_turn >= ctx.loopStartTurn,
		);
		if (entries.length === 0) return content;

		const lines = entries.map((e) => renderHistoryEntry(e));
		return `${content}<current>\n${lines.join("\n")}\n</current>\n`;
	}
}
