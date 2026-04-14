export default class Progress {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleProgress.bind(this), 200);
	}

	async assembleProgress(content, ctx) {
		const { lastContextTokens: usedTokens, contextSize } = ctx;
		const pct = contextSize ? Math.round((usedTokens / contextSize) * 100) : 0;

		const lines = [];
		if (contextSize) {
			lines.push(
				`Using ${usedTokens} tokens (${pct}%) of ${contextSize} token budget. Promote entries with <get/> or set fidelity="promoted" to spend tokens. Set fidelity="demoted" to save tokens.`,
			);
		}
		lines.push(
			"Conclude with a brief <update></update> to continue or a brief <summarize></summarize> if done.",
		);
		const body = lines.join("\n");

		return `${content}<progress turn="${ctx.turn}">${body}</progress>\n`;
	}
}
