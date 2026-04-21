import Entries from "../../agent/Entries.js";

export default class Policy {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("entry.recording", this.#enforceAskMode.bind(this), 1);
	}

	async #reject(ctx, message) {
		await this.#core.hooks.error.log.emit({
			store: ctx.store,
			runId: ctx.runId,
			turn: ctx.turn,
			loopId: ctx.loopId,
			message,
		});
	}

	async #enforceAskMode(entry, ctx) {
		if (ctx.mode !== "ask") return entry;

		if (entry.scheme === "sh") {
			await this.#reject(ctx, "Rejected <sh> in ask mode");
			return { ...entry, state: "failed", outcome: "permission" };
		}

		if (entry.scheme === "set" && entry.attributes?.path) {
			const scheme = Entries.scheme(entry.attributes.path);
			if (scheme === null && entry.body) {
				await this.#reject(
					ctx,
					`Rejected file edit to ${entry.attributes.path} in ask mode`,
				);
				return { ...entry, state: "failed", outcome: "permission" };
			}
		}

		if (entry.scheme === "rm") {
			const pathAttr = entry.attributes?.path || entry.path;
			const scheme = Entries.scheme(pathAttr);
			if (scheme === null) {
				await this.#reject(ctx, `Rejected file rm of ${pathAttr} in ask mode`);
				return { ...entry, state: "failed", outcome: "permission" };
			}
		}

		if (entry.scheme === "mv" || entry.scheme === "cp") {
			const destScheme = Entries.scheme(entry.attributes?.to);
			if (destScheme === null) {
				await this.#reject(
					ctx,
					`Rejected ${entry.scheme} to file ${entry.attributes?.to} in ask mode`,
				);
				return { ...entry, state: "failed", outcome: "permission" };
			}
		}

		return entry;
	}
}
