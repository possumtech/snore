import { readFileSync } from "node:fs";

export default class Env {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
		const docs = readFileSync(new URL("./docs.md", import.meta.url), "utf8");
		core.filter("instructions.toolDocs", async (content) =>
			content ? `${content}\n\n${docs}` : docs,
		);
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		await store.upsert(runId, turn, entry.resultPath, entry.body, 200, {
			attributes: entry.attributes,
			loopId,
		});
	}

	full(entry) {
		return `# env ${entry.attributes.command || ""}\n${entry.body}`;
	}

	summary(entry) {
		return entry.attributes.command || "";
	}
}
