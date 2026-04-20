import { computeBudget } from "../../agent/budget.js";

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
		const { rows, contextSize, toolSet } = ctx;
		const promptEntry = rows.findLast(
			(r) => r.category === "prompt" && r.scheme === "prompt",
		);

		const attrs =
			typeof promptEntry?.attributes === "string"
				? JSON.parse(promptEntry.attributes)
				: promptEntry?.attributes;
		const mode = attrs?.mode || ctx.type;
		const body = promptEntry?.body || "";
		const activeTools = toolSet
			? new Set(toolSet)
			: new Set(this.#core.hooks.tools.names);
		const commands = this.#core.hooks.tools.advertisedNames
			.filter((n) => activeTools.has(n))
			.join(",");
		let warn = "";
		if (mode === "ask") warn = ' warn="File editing disallowed."';

		let budget = "";
		if (contextSize) {
			// Approximation based on row token sums — messages aren't
			// assembled yet. The 10% CEILING_RATIO headroom absorbs the
			// per-entry tag/separator overhead that row tokens miss.
			const { tokenUsage, tokensFree } = computeBudget({ rows, contextSize });
			budget = ` tokenUsage="${tokenUsage}" tokensFree="${tokensFree}"`;
		}

		return `${content}<prompt mode="${mode}" commands="${commands}"${warn}${budget}>${body}</prompt>`;
	}
}
