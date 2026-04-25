import docs from "./updateDoc.js";

const TERMINAL_STATUSES = new Set([200, 204, 422, 500]);

const CONTRACT_REMINDER = "Missing update";

const EMPTY_RESPONSE_REMINDER =
	"Response empty - Update with status 500 if unable to fulfill request.";

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
	 *   - summaryText: non-null → model claimed terminal (200/204/422)
	 *   - updateText:  non-null → model is continuing (1xx)
	 *
	 * Errors (invalid status, missing update) emit via hooks.error.log.
	 * The "terminal + turn had errors → not actually terminal" rule
	 * lives in the error plugin's verdict, not here.
	 */
	async resolve({ recorded, content, runId, turn, loopId, rummy }) {
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

		if (!summaryText && !updateText) {
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
