import docs from "./shDoc.js";

export default class Sh {
	#core;

	constructor(core) {
		this.#core = core;
		// Category "logging" on the proposal entry — it records an action.
		// On accept, AgentLoop.resolve() creates companion _{channel} data
		// entries (category "data") that hold streamed output.
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.sh = docs;
			return docsMap;
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
