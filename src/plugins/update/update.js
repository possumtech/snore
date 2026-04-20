import ResponseHealer from "../../agent/ResponseHealer.js";
import docs from "./updateDoc.js";

const TERMINAL_STATUSES = new Set([200, 204, 422]);
const VALID_STATUSES = new Set([102, ...TERMINAL_STATUSES]);

export default class Update {
	#core;

	constructor(core) {
		this.#core = core;
		core.ensureTool();
		core.registerScheme({ category: "logging" });
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
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
	 * Returns { summaryText, updateText, strike }:
	 *   - summaryText: non-null → the turn is terminal (run concludes at 200)
	 *   - updateText:  non-null → the turn continues
	 *   - strike:      true → the model violated the update contract
	 *                  (no update emitted, missing status attribute, or
	 *                  terminal claim overridden by action failures)
	 *
	 * Rules:
	 *   <update status="200|204|422"> body → summaryText (terminal)
	 *   <update status="102"> body          → updateText (continuation)
	 *   <update> body with no status        → strike, log contract reminder
	 *   terminal update + failed actions    → strike, override to continuation
	 *   no update emitted                   → strike, log contract reminder
	 */
	async resolve({
		recorded,
		hasErrors,
		runId,
		turn,
		loopId,
		rummy,
	}) {
		const entry = recorded.findLast((e) => e.scheme === "update");
		// No status emitted → default to 102 (continuation) per the
		// update tool contract documented in updateDoc.js.
		const status = entry?.attributes?.status ?? 102;
		const isTerminal = TERMINAL_STATUSES.has(status);
		let summaryText = null;
		let updateText = null;
		if (entry?.body) {
			if (isTerminal) summaryText = entry.body;
			else updateText = entry.body;
		}
		let strike = false;

		if (entry && !VALID_STATUSES.has(status)) {
			strike = true;
			await rummy.hooks.error.log.emit({
				store: rummy.entries,
				runId,
				turn,
				loopId,
				message: `Invalid status ${entry.attributes?.status} on update (status = 102 to continue, status = 200 to conclude)`,
			});
		}

		// Terminal update but actions failed → the model overstated success.
		// Override to a continuation and mark the update entry failed/conflict.
		if (summaryText && hasErrors) {
			if (entry?.path) {
				await rummy.entries.set({
					runId,
					path: entry.path,
					state: "failed",
					body: "Overridden — actions in this turn failed. Continue with <update/>.",
					outcome: "conflict",
				});
			}
			updateText = summaryText;
			summaryText = null;
			strike = true;
		}

		if (!summaryText && !updateText) {
			const healed = ResponseHealer.healStatus();
			strike = true;
			await rummy.hooks.error.log.emit({
				store: rummy.entries,
				runId,
				turn,
				loopId,
				message: healed.warning,
			});
		}

		return { summaryText, updateText, strike };
	}

	full(entry) {
		return `# update\n${entry.body}`;
	}

	summary(entry) {
		return this.full(entry);
	}
}
