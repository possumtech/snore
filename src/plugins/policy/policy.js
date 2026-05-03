import Entries from "../../agent/Entries.js";

export default class Policy {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("entry.recording", this.#enforceAskMode.bind(this), 1);
		core.filter("entry.recording", this.#enforceDeliveryMode.bind(this), 2);
	}

	#fail(entry, body) {
		return { ...entry, body, state: "failed", outcome: "permission" };
	}

	#isFileModification(entry) {
		if (entry.scheme === "set" && entry.attributes?.path) {
			const scheme = Entries.scheme(entry.attributes.path);
			if (scheme === null && entry.body) return true;
		}
		if (entry.scheme === "rm") {
			const pathAttr = entry.attributes?.path || entry.path;
			if (Entries.scheme(pathAttr) === null) return true;
		}
		if (entry.scheme === "mv" || entry.scheme === "cp") {
			if (Entries.scheme(entry.attributes?.to) === null) return true;
		}
		return false;
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

	// File modification (set body to file path, rm/mv/cp on file path) is
	// disabled by default and enabled only in Delivery mode (FVSM phase 7).
	// Schema entries (unknown://, known://, log://, …) are always allowed.
	async #enforceDeliveryMode(entry, ctx) {
		if (!this.#isFileModification(entry)) return entry;
		const phase = await this.#core.hooks.instructions.getCurrentPhase({
			entries: ctx.store,
			runId: ctx.runId,
			sequence: ctx.turn,
		});
		if (phase === 7) return entry;
		return this.#fail(entry, "YOU MUST NOT deliver in current mode");
	}
}
