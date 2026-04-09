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
			(r) =>
				r.category === "known" ||
				r.category === "known_index" ||
				r.category === "file" ||
				r.category === "file_index",
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
				(r.category === "result" || r.category === "structural") &&
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
				'Context above 75%. YOU MUST summarize enough entries to free space or the run will fail:\nExample: <set path="known://people/rumsfeld" fidelity="summary" summary="defense,secretary,born 1932"/>\nRestore later with Example: <set path="known://people/rumsfeld" fidelity="full"/>',
			);
		} else if (pct > 50) {
			parts.push(
				'Context above 50%. YOU MAY summarize entries to free space:\nExample: <set path="known://people/rumsfeld" fidelity="summary" summary="defense,secretary,born 1932"/>\nRestore later with Example: <set path="known://people/rumsfeld" fidelity="full"/>',
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
