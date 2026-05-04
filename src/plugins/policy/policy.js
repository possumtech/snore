import Entries from "../../agent/Entries.js";

export default class Policy {
	#core;

	constructor(core) {
		this.#core = core;
		// Decomposition is narrowest — runs first so its message wins when
		// multiple shields would reject the same emission.
		core.filter(
			"entry.recording",
			this.#enforceDecompositionMode.bind(this),
			0,
		);
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
	// Rejection surfaces as an <error> block (via error.log.emit) so the
	// reason reaches the model's context regardless of how the failed
	// operation entry itself renders.
	// Decomposition (FVSM phase 4) is the entry phase: the model surveys
	// the prompt and registers its unknowns, nothing else. Investigation
	// (<get>, <env>, <search>, <sh>) and known:// writes belong to
	// Distillation. Without this gate, a model can search-first then
	// pivot to "the answer is X" without ever decomposing — the
	// "discipline collapse" mode the FVSM exists to prevent.
	async #enforceDecompositionMode(entry, ctx) {
		const phase = await this.#core.hooks.instructions.getCurrentPhase({
			entries: ctx.store,
			runId: ctx.runId,
			sequence: ctx.turn,
		});
		if (phase !== 4) return entry;
		if (this.#isDecompositionPermitted(entry)) return entry;
		const message = "YOU MUST ONLY define unknowns in current mode";
		await this.#core.hooks.error.log.emit({
			store: ctx.store,
			runId: ctx.runId,
			turn: ctx.turn,
			loopId: ctx.loopId,
			message,
			status: 403,
		});
		return this.#fail(entry, message);
	}

	#isDecompositionPermitted(entry) {
		if (entry.scheme === "unknown") return true;
		if (entry.scheme === "update") return true;
		if (entry.scheme === "think") return true;
		if (
			entry.scheme === "set" &&
			typeof entry.attributes?.path === "string" &&
			entry.attributes.path.startsWith("unknown://")
		) {
			return true;
		}
		return false;
	}

	async #enforceDeliveryMode(entry, ctx) {
		if (!this.#isFileModification(entry)) return entry;
		const phase = await this.#core.hooks.instructions.getCurrentPhase({
			entries: ctx.store,
			runId: ctx.runId,
			sequence: ctx.turn,
		});
		if (phase === 7) return entry;
		const message =
			"YOU MUST NOT deliver file modifications in the current mode";
		await this.#core.hooks.error.log.emit({
			store: ctx.store,
			runId: ctx.runId,
			turn: ctx.turn,
			loopId: ctx.loopId,
			message,
			status: 403,
		});
		return this.#fail(entry, message);
	}
}
