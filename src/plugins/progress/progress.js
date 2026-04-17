const CEILING_RATIO = Number(process.env.RUMMY_BUDGET_CEILING);
if (!CEILING_RATIO) throw new Error("RUMMY_BUDGET_CEILING must be set");

export default class Progress {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleProgress.bind(this), 200);
	}

	async assembleProgress(content, ctx) {
		const { rows, contextSize, baselineTokens } = ctx;
		const lines = [];

		if (contextSize) {
			const ceiling = Math.floor(contextSize * CEILING_RATIO);
			const tokenBudget = Math.max(0, ceiling - (baselineTokens || 0));
			// Used = sum of promoted controllable entries' tokens. Same units as
			// per-entry tokens="N" so the model can predict the effect of a
			// promote/demote: change is exactly the entry's tokens attribute.
			const used = rows.reduce((sum, r) => {
				if (
					(r.category === "data" || r.category === "logging") &&
					r.fidelity === "promoted"
				) {
					return sum + (r.tokens || 0);
				}
				return sum;
			}, 0);
			const remaining = Math.max(0, tokenBudget - used);
			lines.push(
				`Token Budget: ${tokenBudget}. Using ${used}. ${remaining} remaining. Promote relevant entries with <get/> to spend. Demote irrelevant entries with <set fidelity="demoted"/> to save.`,
			);
		}
		lines.push(
			'Conclude with <update status="102">progress</update> to continue or <update status="200">answer</update> when done.',
		);
		const body = lines.join("\n");

		return `${content}<progress turn="${ctx.turn}">${body}</progress>\n`;
	}
}
