export default class Prompt {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("turn.started", this.onTurnStarted.bind(this));
		core.filter("assembly.user", this.assemblePrompt.bind(this), 300);
	}

	async onTurnStarted({ rummy, mode, prompt, isContinuation }) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;

		if (!isContinuation && prompt) {
			await store.upsert(runId, turn, `prompt://${turn}`, prompt, 200, {
				attributes: { mode },
				loopId,
			});
		} else {
			await store.upsert(runId, turn, `progress://${turn}`, prompt || "", 200, {
				loopId,
			});
		}
	}

	async assemblePrompt(content, ctx) {
		const promptEntry = ctx.rows.findLast(
			(r) => r.category === "prompt" && r.scheme === "prompt",
		);

		const attrs =
			typeof promptEntry?.attributes === "string"
				? JSON.parse(promptEntry.attributes)
				: promptEntry?.attributes;
		const mode = attrs?.mode || ctx.type;
		const body = promptEntry?.body || "";
		const toolNames = ctx.toolSet
			? [...ctx.toolSet]
			: [...this.#core.hooks.tools.resolveForLoop(mode)];
		const tools = toolNames.join(",");
		const warn = mode === "ask" ? ' warn="File editing disallowed."' : "";

		return `${content}<prompt mode="${mode}" tools="${tools}"${warn}>${body}</prompt>`;
	}
}
