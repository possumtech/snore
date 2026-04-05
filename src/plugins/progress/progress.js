export default class Progress {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleProgress.bind(this), 200);
	}

	async assembleProgress(content, ctx) {
		const usedTokens = ctx.rows.reduce((sum, r) => sum + (r.tokens || 0), 0);
		const contextSize = ctx.contextSize || 0;
		const pct = contextSize ? Math.round((usedTokens / contextSize) * 100) : 0;

		const unknownCount = ctx.rows.filter(
			(r) => r.category === "unknown",
		).length;

		const hasCurrent = ctx.rows.some(
			(r) =>
				(r.category === "result" || r.category === "structural") &&
				r.source_turn >= ctx.loopStartTurn,
		);

		const parts = [];

		const tokenInfo = contextSize
			? `${usedTokens} of ${contextSize} tokens (${pct}%)`
			: "";
		const unknownInfo =
			unknownCount > 0
				? `${unknownCount} unknown${unknownCount > 1 ? "s" : ""} remaining`
				: "0 unknowns";
		const status = [tokenInfo, unknownInfo].filter(Boolean).join(" · ");
		if (status) parts.push(status);

		if (hasCurrent) {
			parts.push(
				"The above actions were performed in response to the following prompt:",
			);
		}

		return `${content}<progress>${parts.join("\n")}</progress>\n`;
	}
}
