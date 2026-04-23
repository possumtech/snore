import docs from "./ask_userDoc.js";

const LOG_ACTION_RE = /^log:\/\/turn_\d+\/(\w+)\//;

export default class AskUser {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.ask_user = docs;
			return docsMap;
		});
		core.on("proposal.accepted", this.#onResolved.bind(this));
		core.on("proposal.rejected", this.#onResolved.bind(this));
	}

	async #onResolved(ctx) {
		const m = LOG_ACTION_RE.exec(ctx.path);
		if (m?.[1] !== "ask_user") return;
		if (!ctx.output) return;
		const turn = (await ctx.db.get_run_by_id.get({ id: ctx.runId })).next_turn;
		await ctx.entries.set({
			runId: ctx.runId,
			turn,
			path: ctx.path,
			body: ctx.resolvedBody,
			attributes: { ...(ctx.attrs || {}), answer: ctx.output },
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		// XmlParser resolved question/options from attr-or-body already.
		const { question, options: rawOptions } = entry.attributes;

		let options = [];
		if (rawOptions) {
			const delimiter = rawOptions.includes(";") ? ";" : ",";
			options = rawOptions
				.split(delimiter)
				.map((o) => o.trim())
				.filter(Boolean);
		}

		await store.set({
			runId,
			turn,
			path: entry.resultPath,
			body: entry.body,
			state: "proposed",
			attributes: { question, options },
			loopId,
		});
	}

	full(entry) {
		const { question, answer } = entry.attributes;
		const lines = ["# ask_user"];
		if (question) lines.push(`# Question: ${question}`);
		if (answer) lines.push(`# Answer: ${answer}`);
		return lines.join("\n");
	}

	summary(entry) {
		const { question, answer } = entry.attributes;
		if (answer) return `${question} → ${answer}`;
		return question;
	}
}
