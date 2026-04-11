import KnownStore from "../../agent/KnownStore.js";
import docs from "./rmDoc.js";

export default class Rm {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.rm = docs;
			return docsMap;
		});
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

		const fileMatches = matches.filter((m) => m.scheme === null);
		const schemeMatches = matches.filter((m) => m.scheme !== null);

		// Scheme entries: remove all, write one aggregate result entry
		for (const match of schemeMatches) await store.remove(runId, match.path);
		if (schemeMatches.length > 0) {
			const paths = schemeMatches.map((m) => m.path).join("\n");
			await store.upsert(runId, turn, entry.resultPath, paths, 200, {
				attributes: { path: target },
				loopId,
			});
		}

		// File entries: individual 202 proposals (require user resolution)
		if (fileMatches.length > 0 && schemeMatches.length > 0)
			await store.remove(runId, entry.resultPath);
		for (const match of fileMatches) {
			const resultPath =
				schemeMatches.length === 0 && fileMatches.length === 1
					? entry.resultPath
					: await store.dedup(runId, "rm", match.path, turn);
			await store.upsert(runId, turn, resultPath, match.path, 202, {
				attributes: { path: match.path },
				loopId,
			});
		}
	}

	full(entry) {
		const header = `# rm ${entry.attributes.path || entry.path}`;
		return entry.body ? `${header}\n${entry.body}` : header;
	}

	summary(entry) {
		return this.full(entry);
	}
}
