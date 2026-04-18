const CEILING_RATIO = Number(process.env.RUMMY_BUDGET_CEILING);
if (!CEILING_RATIO) throw new Error("RUMMY_BUDGET_CEILING must be set");

export default class Prompt {
	#core;

	constructor(core) {
		this.#core = core;
		core.hooks.tools.onView("prompt", (entry) => entry.body, "promoted");
		core.hooks.tools.onView(
			"prompt",
			(entry) => {
				const limit = 500;
				const text = entry.body?.slice(0, limit) || "";
				return text.length < (entry.body?.length || 0)
					? `${text}\n[truncated — promote to see the complete prompt]`
					: text;
			},
			"demoted",
		);
		core.on("turn.started", this.onTurnStarted.bind(this));
		core.filter("assembly.user", this.assemblePrompt.bind(this), 300);
	}

	async onTurnStarted({ rummy, mode, prompt, isContinuation }) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;

		if (!isContinuation && prompt) {
			// prompt:// writable_by: ["plugin"] — explicit for clarity.
			await store.set({
				runId,
				turn,
				path: `prompt://${turn}`,
				body: prompt,
				state: "resolved",
				attributes: { mode },
				loopId,
				writer: "plugin",
			});
		}
	}

	async assemblePrompt(content, ctx) {
		const { rows, contextSize, baselineTokens } = ctx;
		const promptEntry = rows.findLast(
			(r) => r.category === "prompt" && r.scheme === "prompt",
		);

		const attrs =
			typeof promptEntry?.attributes === "string"
				? JSON.parse(promptEntry.attributes)
				: promptEntry?.attributes;
		const mode = attrs?.mode || ctx.type;
		const body = promptEntry?.body || "";
		// No tools="..." attribute. The OpenAI-shaped
		// `<prompt mode tools="x,y,z">` rendering was priming gemma's
		// native-tool-call training prior — A/B test confirmed removing
		// the attribute dropped native-format emissions from ~50% to 0%.
		// Tools list lives in the system prompt as "XML Command Tools:".
		let warn = "";
		if (mode === "ask") warn = ' warn="File editing disallowed."';

		let budget = "";
		if (contextSize) {
			const ceiling = Math.floor(contextSize * CEILING_RATIO);
			const tokenBudget = Math.max(0, ceiling - (baselineTokens || 0));
			// Usage = sum of promoted controllable entries' tokens. Same
			// units as per-entry tokens="N" so the model can predict the
			// effect of a promote/demote: change is exactly the entry's
			// tokens attribute.
			const tokenUsage = rows.reduce((sum, r) => {
				if (
					(r.category === "data" || r.category === "logging") &&
					r.fidelity === "promoted"
				) {
					return sum + (r.tokens || 0);
				}
				return sum;
			}, 0);
			budget = ` tokenBudget="${tokenBudget}" tokenUsage="${tokenUsage}"`;
		}

		return `${content}<prompt mode="${mode}"${warn}${budget}>${body}</prompt>`;
	}
}
