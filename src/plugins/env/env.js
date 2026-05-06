import { logPathToDataBase, streamSummary } from "../helpers.js";
import docs from "./envDoc.js";

const LOG_ACTION_RE = /^log:\/\/turn_\d+\/(\w+)\//;

export default class Env {
	#core;

	constructor(core) {
		this.#core = core;
		// env vs sh: env is read-only (allowed in ask-mode); see plugin README.
		// Streaming stdout/stderr is time-indexed activity output, not
		// topic-indexed state — category="logging" so it renders in <log>
		// adjacent to its action entry, not in <summary>/<visible>.
		core.registerScheme({ category: "logging" });
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.env = docs;
			return docsMap;
		});
		core.on("proposal.accepted", this.#onAccepted.bind(this));
	}

	async #onAccepted(ctx) {
		const m = LOG_ACTION_RE.exec(ctx.path);
		if (m?.[1] !== "env") return;
		let command = "";
		if (ctx.attrs?.command) command = ctx.attrs.command;
		else if (ctx.attrs?.tags) command = ctx.attrs.tags;
		const turn = (await ctx.db.get_run_by_id.get({ id: ctx.runId })).next_turn;
		const dataBase = logPathToDataBase(ctx.path);
		for (const ch of [1, 2]) {
			await ctx.entries.set({
				runId: ctx.runId,
				turn,
				path: `${dataBase}_${ch}`,
				body: "",
				state: "streaming",
				visibility: "summarized",
				attributes: { command, tags: command, channel: ch },
			});
		}
		await ctx.entries.set({
			runId: ctx.runId,
			path: ctx.path,
			state: "resolved",
			body: `ran '${command}' (in progress). Output: ${dataBase}_1, ${dataBase}_2`,
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		await store.set({
			runId,
			turn,
			path: entry.resultPath,
			body: "",
			state: "proposed",
			attributes: { ...entry.attributes, tags: entry.attributes.command },
			loopId,
		});
	}

	full(entry) {
		return `# env ${entry.attributes.command}\n${entry.body}`;
	}

	summary(entry) {
		return streamSummary("env", entry);
	}
}
