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
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const status = entry.attributes?.status ?? 102;
		const validation = await rummy.hooks.instructions.validateNavigation(
			status,
			rummy,
		);
		if (!validation.ok) {
			entry.state = "failed";
			entry.outcome = "invalid_navigation";
			entry.body = validation.reason;
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath,
				body: validation.reason,
				state: "failed",
				outcome: "invalid_navigation",
				attributes: { status },
			});
			return;
		}
		if (!isValidStatus(status)) {
			entry.state = "failed";
			entry.outcome = "invalid_status";
			const message = `Invalid status ${status} on update — use 1xx to continue or 200 to conclude.`;
			entry.body = message;
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath,
				body: message,
				state: "failed",
				outcome: "invalid_status",
				attributes: { status },
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
