import { readFileSync } from "node:fs";
import KnownStore from "../../agent/KnownStore.js";

export default class Rm {
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
		const target = entry.attributes.path;
		if (!target) {
			await store.upsert(runId, turn, entry.resultPath, "", 400, {
				attributes: { error: "path is required" },
				loopId,
			});
			return;
		}
		const normalized = KnownStore.normalizePath(target);
		const matches = await store.getEntriesByPattern(
			runId,
			normalized,
			entry.attributes.body,
		);

		if (matches.length === 0) {
			await store.upsert(runId, turn, entry.resultPath, "", 404, {
				attributes: { path: target, error: `${target} not found` },
				loopId,
			});
			return;
		}

		for (const match of matches) {
			const resultPath = `rm://${match.path}`;
			if (match.scheme === null) {
				await store.upsert(runId, turn, resultPath, match.path, 202, {
					attributes: { path: match.path },
					loopId,
				});
			} else {
				await store.remove(runId, match.path);
				await store.upsert(runId, turn, resultPath, match.path, 200, {
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
