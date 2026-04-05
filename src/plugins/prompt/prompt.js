export default class Prompt {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assemblePrompt.bind(this), 300);
	}

	async assemblePrompt(content, ctx) {
		const promptEntry = ctx.rows.findLast(
			(r) =>
				r.category === "prompt" && (r.scheme === "ask" || r.scheme === "act"),
		);

		const mode = promptEntry?.scheme || ctx.type;
		const body = promptEntry?.body || "";
		const warn =
			mode === "ask"
				? ' warn="File and system modification prohibited on this turn."'
				: "";

		return `${content}<${mode} tools="${ctx.tools}"${warn}>${body}</${mode}>`;
	}
}
