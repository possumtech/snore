import Entries from "../../agent/Entries.js";

export default class Policy {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("entry.recording", this.#enforceAskMode.bind(this), 1);
	}

	#fail(entry) {
		return { ...entry, state: "failed", outcome: "permission" };
	}

	async #enforceAskMode(entry, ctx) {
		if (ctx.mode !== "ask") return entry;

		let message = null;
		if (entry.scheme === "sh") {
			message = "Rejected <sh> in ask mode";
		} else if (entry.scheme === "set" && entry.attributes?.path) {
			const scheme = Entries.scheme(entry.attributes.path);
			if (scheme === null && entry.body) {
				message = `Rejected file edit to ${entry.attributes.path} in ask mode`;
			}
		} else if (entry.scheme === "rm") {
			const pathAttr = entry.attributes?.path || entry.path;
			const scheme = Entries.scheme(pathAttr);
			if (scheme === null) {
				message = `Rejected file rm of ${pathAttr} in ask mode`;
			}
		} else if (entry.scheme === "mv" || entry.scheme === "cp") {
			const destScheme = Entries.scheme(entry.attributes?.to);
			if (destScheme === null) {
				message = `Rejected ${entry.scheme} to file ${entry.attributes?.to} in ask mode`;
			}
		}

		if (!message) return entry;
		await this.#core.hooks.error.log.emit({
			store: ctx.store,
			runId: ctx.runId,
			turn: ctx.turn,
			loopId: ctx.loopId,
			message,
			status: 403,
		});
		return this.#fail(entry);
	}
}
