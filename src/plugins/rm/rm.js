import { readFileSync } from "node:fs";

export default class Rm {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({
			validStates: ["full", "proposed", "pass", "rejected", "error", "pattern"],
		});
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
		const target = entry.attributes.path;
		const matches = await store.getEntriesByPattern(
			runId,
			target,
			entry.attributes.body,
		);

		for (const match of matches) {
			const resultPath = `rm://${match.path}`;
			if (match.scheme === null) {
				await store.upsert(runId, turn, resultPath, match.path, "proposed", {
					attributes: { path: match.path },
					loopId,
				});
			} else {
				await store.remove(runId, match.path);
				await store.upsert(runId, turn, resultPath, match.path, "pass", {
					attributes: { path: match.path },
					loopId,
				});
			}
		}
	}

	full(entry) {
		return `# rm ${entry.attributes.path || entry.path}`;
	}

	summary(entry) {
		return this.full(entry);
	}
}
