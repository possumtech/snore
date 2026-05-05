import Entries from "../../agent/Entries.js";

export default class Policy {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("entry.recording", this.#enforceAskMode.bind(this), 1);
		core.filter("entry.recording", this.#enforceDeliveryMode.bind(this), 2);
	}

	// Mark the entry failed without destroying its body. The body is the
	// model's recorded intent — what it tried — and stays intact so the
	// model can reflect on its own action when reading the log later.
	// The rejection reason lives in a separate `log://turn_N/error/...`
	// entry emitted by the caller via `hooks.error.log.emit`.
	#fail(entry) {
		return { ...entry, state: "failed", outcome: "permission" };
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

	// File modification (bare-path `<set body>`, `<rm>`, `<mv>`, `<cp>`
	// to bare-path) is the high-blast-radius operation; only Delivery
	// (FVSM phase 7) permits it. Schema entries (unknown://, known://,
	// log://, …) are always allowed. Rejection surfaces as an <error>
	// block via error.log.emit so the reason reaches the model's
	// context regardless of how the failed operation entry renders.
	// SPEC.md @fvsm_state_machine documents this as the fourth rule.
	async #enforceDeliveryMode(entry, ctx) {
		if (!this.#isFileModification(entry)) return entry;
		const phase = await this.#core.hooks.instructions.getCurrentPhase({
			entries: ctx.store,
			runId: ctx.runId,
			sequence: ctx.turn,
		});
		if (phase === 7) return entry;
		const message = "YOU MUST NOT attempt to deliver before Delivery Mode";
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
