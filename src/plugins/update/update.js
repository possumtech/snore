import docs from "./updateDoc.js";

const CONTRACT_REMINDER = "Missing update";

const EMPTY_RESPONSE_REMINDER = "Response empty";

export default class Update {
	#core;

	constructor(core) {
		this.#core = core;
		core.ensureTool();
		core.registerScheme({ category: "logging" });
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.update = docs;
			return docsMap;
		});
		core.hooks.update = {
			resolve: this.resolve.bind(this),
		};
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const status = entry.attributes?.status;

		// Only 200 has terminal meaning. Any other status (or none) is a
		// continuation update — accepted unconditionally.
		if (status === 200) {
			const reason = await this.#deliveryCoherenceCheck(rummy);
			if (reason) {
				entry.state = "failed";
				entry.outcome = "incoherent_delivery";
				entry.body = reason;
				await rummy.hooks.error.log.emit({
					store,
					runId,
					turn,
					loopId,
					message: reason,
					status: 403,
				});
				return;
			}
		}

		await rummy.update(entry.body, { status });
	}

	// 200 is the only terminal status; the engine refuses it while any
	// `unknown://` is visible (the model said it doesn't know X; can't
	// claim done with X still unresolved) or any prior prompt is visible
	// (legacy delivery integrity check). Returns the rejection reason or
	// null if coherent.
	async #deliveryCoherenceCheck(rummy) {
		const { entries: store, runId } = rummy;
		const unknowns = await store.getEntriesByPattern(
			runId,
			"unknown://**",
			null,
		);
		const visibleUnknowns = unknowns.filter((u) => u.visibility === "visible");
		if (visibleUnknowns.length > 0) {
			return `Cannot deliver: ${visibleUnknowns.length} unknown(s) still visible. Demote them (RESOLVED or REJECTED) first.`;
		}
		const visiblePriorPrompts = await this.#countVisiblePriorPrompts(rummy);
		if (visiblePriorPrompts > 0) {
			return `Cannot deliver: ${visiblePriorPrompts} prior prompt(s) still visible. Demote them first.`;
		}
		return null;
	}

	async #countVisiblePriorPrompts(rummy) {
		const prompts = await rummy.entries.getEntriesByPattern(
			rummy.runId,
			"prompt://*",
			null,
		);
		const visible = prompts.filter((p) => p.visibility === "visible");
		if (visible.length === 0) return 0;
		// Exclude the latest prompt; only PRIOR prompts trigger the gate.
		let maxNum = -1;
		for (const p of visible) {
			const m = /^prompt:\/\/(\d+)$/.exec(p.path);
			if (m && Number(m[1]) > maxNum) maxNum = Number(m[1]);
		}
		return visible.filter((p) => {
			const m = /^prompt:\/\/(\d+)$/.exec(p.path);
			return !m || Number(m[1]) !== maxNum;
		}).length;
	}

	async resolve({ recorded, content, runId, turn, loopId, rummy }) {
		const entry = recorded.findLast((e) => e.scheme === "update");
		const status = entry?.attributes?.status;
		const failed = entry?.state === "failed";
		const isTerminal = status === 200 && !failed;
		let summaryText = null;
		let updateText = null;
		if (entry?.body && !failed) {
			if (isTerminal) summaryText = entry.body;
			else updateText = entry.body;
		}

		if (!summaryText && !updateText && !failed) {
			const empty = !content || content.trim() === "";
			await rummy.hooks.error.log.emit({
				store: rummy.entries,
				runId,
				turn,
				loopId,
				message: empty ? EMPTY_RESPONSE_REMINDER : CONTRACT_REMINDER,
				status: 422,
			});
		}

		return { summaryText, updateText };
	}

	full(entry) {
		return `# update\n${entry.body}`;
	}

	summary(entry) {
		return this.full(entry);
	}
}
