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

		const knownCount = ctx.rows.filter(
			(r) => r.category === "known" || r.category === "known_index",
		).length;
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
		const knownInfo = `${knownCount} known${knownCount !== 1 ? "s" : ""}`;
		const unknownInfo =
			unknownCount > 0
				? `${unknownCount} unknown${unknownCount > 1 ? "s" : ""} remaining`
				: "0 unknowns";
		const status = [tokenInfo, knownInfo, unknownInfo]
			.filter(Boolean)
			.join(" · ");
		if (status) parts.push(status);

		if (ctx.demoted?.length > 0) {
			parts.push(
				`⚠ ${ctx.demoted.length} entries auto-compressed. Summaries may be lossy — <get> to verify.`,
			);
		} else if (pct > 75) {
			parts.push(
				'Context above 75%. YOU MUST summarize enough entries to free space or entries will be auto-compressed:\n<set path="known://..." fidelity="summary" summary="keyword1, keyword2, keyword3"/>\nRestore with <set path="known://..." fidelity="full"/>',
			);
		} else if (pct > 50) {
			parts.push(
				'Context above 50%. YOU MAY summarize entries to free space:\n<set path="known://..." fidelity="summary" summary="keyword1, keyword2, keyword3"/>\nRestore with <set path="known://..." fidelity="full"/>',
			);
		}

		if (hasCurrent) {
			parts.push(
				"The above actions were performed in response to the following prompt:",
			);
		}

		return `${content}<progress>${parts.join("\n")}</progress>\n`;
	}
}
