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
		await rummy.update(entry.body, { status: entry.attributes?.status });
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
