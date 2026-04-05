export default class Progress {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleProgress.bind(this), 200);
	}

	async assembleProgress(content, ctx) {
		// Find progress:// entry body if present
		const progressEntry = ctx.rows.find(
			(r) => r.category === "prompt" && r.scheme === "progress",
		);

		const hasCurrent = ctx.rows.some(
			(r) =>
				(r.category === "result" || r.category === "structural") &&
				r.source_turn >= ctx.loopStartTurn,
		);

		const text =
			progressEntry?.body ||
			(hasCurrent
				? "The above actions were performed in response to the following prompt:"
				: "Begin.");

		return `${content}<progress>${text}</progress>\n`;
	}
}
