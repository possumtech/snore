import docs from "./shDoc.js";

const LOG_ACTION_RE = /^log:\/\/turn_\d+\/(\w+)\//;

export default class Sh {
	#core;

	constructor(core) {
		this.#core = core;
		// Category "logging" on the proposal entry — it records an action.
		// On accept, this plugin (via proposal.accepted) creates companion
		// _{channel} data entries (category "data") that hold streamed output.
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.sh = docs;
			return docsMap;
		});
		core.on("proposal.accepted", this.#onAccepted.bind(this));
	}

	async #onAccepted(ctx) {
		const m = LOG_ACTION_RE.exec(ctx.path);
		if (m?.[1] !== "sh") return;
		let command = "";
		if (ctx.attrs?.command) command = ctx.attrs.command;
		else if (ctx.attrs?.summary) command = ctx.attrs.summary;
		const turn = (await ctx.db.get_run_by_id.get({ id: ctx.runId })).next_turn;
		for (const ch of [1, 2]) {
			await ctx.entries.set({
				runId: ctx.runId,
				turn,
				path: `${ctx.path}_${ch}`,
				body: "",
				state: "streaming",
				visibility: "summarized",
				attributes: { command, summary: command, channel: ch },
			});
		}
		await ctx.entries.set({
			runId: ctx.runId,
			path: ctx.path,
			state: "resolved",
			body: `ran '${command}' (in progress). Output: ${ctx.path}_1, ${ctx.path}_2`,
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		// Proposal at 202 with the command as summary and empty body — the
		// body fills in on accept (log message about the action). Data
		// entries with stdout/stderr are created on accept in resolve().
		await store.set({
			runId,
			turn,
			path: entry.resultPath,
			body: "",
			state: "proposed",
			attributes: { ...entry.attributes, summary: entry.attributes.command },
			loopId,
		});
	}

	full(entry) {
		return `# sh ${entry.attributes.command}\n${entry.body}`;
	}

	summary() {
		return "";
	}
}
