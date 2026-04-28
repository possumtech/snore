import Entries from "../../agent/Entries.js";

export default class Policy {
	constructor(core) {
		core.filter("entry.recording", this.#enforceAskMode.bind(this), 1);
	}

	#fail(entry, body) {
		return { ...entry, body, state: "failed", outcome: "permission" };
	}

	async #enforceAskMode(entry, ctx) {
		if (ctx.mode !== "ask") return entry;

		if (entry.scheme === "sh") {
			return this.#fail(entry, "Rejected <sh> in ask mode");
		}

		if (entry.scheme === "set" && entry.attributes?.path) {
			const scheme = Entries.scheme(entry.attributes.path);
			if (scheme === null && entry.body) {
				return this.#fail(
					entry,
					`Rejected file edit to ${entry.attributes.path} in ask mode`,
				);
			}
		}

		if (entry.scheme === "rm") {
			const pathAttr = entry.attributes?.path || entry.path;
			const scheme = Entries.scheme(pathAttr);
			if (scheme === null) {
				return this.#fail(entry, `Rejected file rm of ${pathAttr} in ask mode`);
			}
		}

		if (entry.scheme === "mv" || entry.scheme === "cp") {
			const destScheme = Entries.scheme(entry.attributes?.to);
			if (destScheme === null) {
				return this.#fail(
					entry,
					`Rejected ${entry.scheme} to file ${entry.attributes?.to} in ask mode`,
				);
			}
		}

		return entry;
	}
}
