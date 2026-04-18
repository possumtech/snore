import ResponseHealer from "../../agent/ResponseHealer.js";
import docs from "./updateDoc.js";

const TERMINAL_STATUSES = new Set([200, 204, 422]);

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
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const updateStatus = entry.attributes?.status ?? 102;
		const statusPath = await store.slugPath(runId, "update", entry.body);
		await store.upsert(runId, turn, statusPath, entry.body, "resolved", {
			loopId,
			attributes: { status: updateStatus },
		});
	}

	/**
	 * Classify this turn's update state and heal when missing.
	 *
	 * Returns { summaryText, updateText, statusHealed }:
	 *   - summaryText: non-null → the turn is terminal (run concludes)
	 *   - updateText:  non-null → the turn continues
	 *   - statusHealed: true → values were inferred from raw content
	 *
	 * Rules:
	 *   <update status="200|204|422"> body → summaryText (terminal)
	 *   <update status="102"> body          → updateText (continuation)
	 *   <update> body with no status        → log error, treat as continuation
	 *   terminal update + failed actions    → override to continuation
	 *                                         (resolve update entry to 409)
	 *   no update emitted                   → heal from raw content
	 */
	async resolve({
		recorded,
		hasErrors,
		content,
		commands,
		runId,
		turn,
		loopId,
		rummy,
	}) {
		const entry = recorded.findLast((e) => e.scheme === "update");
		const status = entry?.attributes?.status ?? 102;
		const isTerminal = TERMINAL_STATUSES.has(status);
		let summaryText = isTerminal ? entry?.body || null : null;
		let updateText = !isTerminal ? entry?.body || null : null;

		if (entry && !entry.attributes?.status) {
			await rummy.hooks.error.log.emit({
				store: rummy.entries,
				runId,
				turn,
				loopId,
				message:
					'update missing status attribute. Use status="102" to continue or status="200" when done.',
			});
		}

		// Terminal update but actions failed → the model overstated success.
		// Override to a continuation and mark the update entry failed/conflict.
		if (summaryText && hasErrors) {
			if (entry?.path) {
				await rummy.entries.resolve(runId, entry.path, "failed", {
					body: "Overridden — actions in this turn failed. Continue with <update/>.",
					outcome: "conflict",
				});
			}
			updateText = summaryText;
			summaryText = null;
		}

		// No update emitted at all → infer from raw content.
		let statusHealed = false;
		if (!summaryText && !updateText) {
			const healed = ResponseHealer.healStatus(content, commands);
			summaryText = healed.summaryText;
			updateText = healed.updateText;
			statusHealed = true;
			if (healed.warning) {
				await rummy.hooks.error.log.emit({
					store: rummy.entries,
					runId,
					turn,
					loopId,
					message: healed.warning,
				});
			}
		}

		return { summaryText, updateText, statusHealed };
	}

	full(entry) {
		return `# update\n${entry.body}`;
	}

	summary(entry) {
		return this.full(entry);
	}
}
