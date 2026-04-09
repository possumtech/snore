export default class Progress {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleProgress.bind(this), 200);
	}

	async assembleProgress(content, ctx) {
		// Use last turn's real assembled token count when available.
		// Falls back to row token sum (less accurate — missing system prompt overhead).
		const rowTokens = ctx.rows.reduce((sum, r) => sum + (r.tokens || 0), 0);
		const usedTokens = ctx.lastContextTokens || rowTokens;
		const contextSize = ctx.contextSize || 0;
		const pct = contextSize ? Math.round((usedTokens / contextSize) * 100) : 0;

		// Fidelity distribution across known/file entries
		const entries = ctx.rows.filter(
			(r) => r.category === "data",
		);
		const fullEntries = entries.filter((r) => r.fidelity === "full");
		const summaryEntries = entries.filter((r) => r.fidelity === "summary");
		const indexEntries = entries.filter((r) => r.fidelity === "index");
		const fullTokens = fullEntries.reduce((s, r) => s + (r.tokens || 0), 0);
		const summaryTokens = summaryEntries.reduce(
			(s, r) => s + (r.tokens || 0),
			0,
		);
		const indexTokens = indexEntries.reduce(
			(s, r) => s + (r.tokens || 0),
			0,
		);

		const unknownCount = ctx.rows.filter(
			(r) => r.category === "unknown",
		).length;

		const hasCurrent = ctx.rows.some(
			(r) =>
				r.category === "logging" &&
				r.source_turn >= ctx.loopStartTurn,
		);

		const parts = [];

		const knownCount = entries.length;
		const tokenLine = contextSize
			? `${usedTokens} of ${contextSize} tokens (${pct}%) · ${knownCount} known${knownCount !== 1 ? "s" : ""} · ${unknownCount} unknown${unknownCount !== 1 ? "s" : ""}`
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
			fidelityParts.push(
				`${indexEntries.length} index (${indexTokens} tok)`,
			);
		if (fidelityParts.length > 0)
			parts.push(`Entries: ${fidelityParts.join(" · ")}`);

		if (pct > 75) {
			parts.push(
				'Context above 75%. YOU MUST free space by lowering the fidelity of entries with large token sizes or the run will fail:\nExample: <set path="src/app.js" fidelity="summary" summary="keyword1,keyword2,keyword3"/>\nRestore later: <set path="src/app.js" fidelity="full"/>',
			);
		} else if (pct > 50) {
			parts.push(
				'Context above 50%. You may free space by lowering the fidelity of entries with large token sizes:\nExample: <set path="src/app.js" fidelity="summary" summary="keyword1,keyword2,keyword3"/>\nRestore later: <set path="src/app.js" fidelity="full"/>',
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
