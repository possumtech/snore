export default class Progress {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleProgress.bind(this), 200);
	}

	async assembleProgress(content, ctx) {
		const { lastContextTokens: usedTokens, contextSize } = ctx;
		const pct = contextSize ? Math.round((usedTokens / contextSize) * 100) : 0;

		// Fidelity distribution across all manageable entries (data + logging)
		const dataEntries = ctx.rows.filter((r) => r.category === "data");
		const loggingEntries = ctx.rows.filter((r) => r.category === "logging");
		const entries = [...dataEntries, ...loggingEntries];
		const fullEntries = entries.filter((r) => r.fidelity === "full");
		const summaryEntries = entries.filter((r) => r.fidelity === "summary");
		const indexEntries = entries.filter((r) => r.fidelity === "index");
		const fullTokens = fullEntries.reduce((s, r) => s + r.tokens, 0);
		const summaryTokens = summaryEntries.reduce((s, r) => s + r.tokens, 0);
		const indexTokens = indexEntries.reduce((s, r) => s + r.tokens, 0);

		const unknownCount = ctx.rows.filter(
			(r) => r.category === "unknown",
		).length;

		const hasPerformed = loggingEntries.some(
			(r) => r.source_turn >= ctx.loopStartTurn,
		);

		const parts = [];

		const knownCount = dataEntries.length;
		const loggingCount = loggingEntries.length;
		const tokenLine = contextSize
			? `${usedTokens} of ${contextSize} tokens (${pct}%) · ${knownCount} known${knownCount !== 1 ? "s" : ""} · ${loggingCount} logging · ${unknownCount} unknown${unknownCount !== 1 ? "s" : ""}`
			: "";
		if (tokenLine) parts.push(tokenLine);

		// Fidelity distribution
		const fidelityParts = [];
		if (fullEntries.length > 0)
			fidelityParts.push(`${fullEntries.length} full (${fullTokens} tok)`);
		if (summaryEntries.length > 0)
			fidelityParts.push(
				`${summaryEntries.length} summary (${summaryTokens} tok)`,
			);
		if (indexEntries.length > 0)
			fidelityParts.push(`${indexEntries.length} index (${indexTokens} tok)`);
		if (fidelityParts.length > 0)
			parts.push(`Entries: ${fidelityParts.join(" · ")}`);

		if (hasPerformed) {
			parts.push(
				"The above actions were performed in response to the following prompt:",
			);
		}

		return `${content}<progress turn="${ctx.turn}">${parts.join("\n")}</progress>\n`;
	}
}
