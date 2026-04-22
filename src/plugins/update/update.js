import docs from "./updateDoc.js";

const TERMINAL_STATUSES = new Set([200, 204, 422]);

const CONTRACT_REMINDER =
	"Missing update — use 1xx to continue or 200 to conclude.";

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
		const status = entry.attributes?.status ?? 102;
		await rummy.update(entry.body, { status });
	}

	/**
	 * Classify this turn's update state.
	 *
	 * Returns { summaryText, updateText }:
	 *   - summaryText: non-null → the turn is terminal (run concludes at 200)
	 *   - updateText:  non-null → the turn continues
	 *
	 * Error emissions (all go to hooks.error.log, which tracks strikes):
	 *   <update> body with no/invalid status → error 422
	 *   terminal update + this turn had errors → override to continuation
	 *   no update emitted                     → error 422, contract reminder
	 */
	async resolve({ recorded, runId, turn, loopId, rummy }) {
		const entry = recorded.findLast((e) => e.scheme === "update");
		const status = entry?.attributes?.status ?? 102;
		const isTerminal = TERMINAL_STATUSES.has(status);
		let summaryText = null;
		let updateText = null;
		if (entry?.body) {
			if (isTerminal) summaryText = entry.body;
			else updateText = entry.body;
		}

		if (entry && !isValidStatus(status)) {
			await rummy.hooks.error.log.emit({
				store: rummy.entries,
				runId,
				turn,
				loopId,
				message: `Invalid status ${entry.attributes?.status} on update — use 1xx to continue or 200 to conclude.`,
				status: 422,
			});
		}

		const hasErrors = rummy.hooks.error.turnHasErrors({ loopId });

		if (summaryText && hasErrors) {
			if (entry?.path) {
				await rummy.entries.set({
					runId,
					path: entry.path,
					state: "failed",
					body: "Overridden — actions in this turn failed. Continue with status 102.",
					outcome: "conflict",
				});
			}
			updateText = summaryText;
			summaryText = null;
		}

		if (!summaryText && !updateText) {
			await rummy.hooks.error.log.emit({
				store: rummy.entries,
				runId,
				turn,
				loopId,
				message: CONTRACT_REMINDER,
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
