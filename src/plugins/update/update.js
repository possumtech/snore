import docs from "./updateDoc.js";

const TERMINAL_STATUSES = new Set([200, 204, 422, 500]);

const CONTRACT_REMINDER = "Missing update";

const EMPTY_RESPONSE_REMINDER = "Response empty";

function isValidStatus(status) {
	if (TERMINAL_STATUSES.has(status)) return true;
	return Number.isInteger(status) && status >= 100 && status < 200;
}

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
		const status = entry.attributes?.status ?? 102;
		const validation = await rummy.hooks.instructions.validateNavigation(
			status,
			rummy,
		);
		// Rejected advance attempts surface as <error> blocks only.
		// Per SPEC.md @fvsm_state_machine: a rejected update is NOT
		// recorded as a phase-history entry — getCurrentPhase keys off
		// the most recent successful advance, so writing a failed row
		// here would either lie about advancement or require a special-
		// case skip downstream. Neither is the contract.
		if (!validation.ok) {
			entry.state = "failed";
			entry.outcome = "invalid_navigation";
			entry.body = validation.reason;
			await rummy.hooks.error.log.emit({
				store,
				runId,
				turn,
				loopId,
				message: validation.reason,
				status: 403,
			});
			return;
		}
		if (!isValidStatus(status)) {
			entry.state = "failed";
			entry.outcome = "invalid_status";
			const message = "Invalid status";
			entry.body = message;
			await rummy.hooks.error.log.emit({
				store,
				runId,
				turn,
				loopId,
				message,
				status: 422,
			});
			return;
		}
		await rummy.update(entry.body, { status });
	}

	async resolve({ recorded, content, runId, turn, loopId, rummy }) {
		const entry = recorded.findLast((e) => e.scheme === "update");
		const status = entry?.attributes?.status ?? 102;
		const failed = entry?.state === "failed";
		const isTerminal = TERMINAL_STATUSES.has(status) && !failed;
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
