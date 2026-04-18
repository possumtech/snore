import Repository from "../../agent/Repository.js";
import docs from "./rmDoc.js";

export default class Rm {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.rm = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const target = entry.attributes.path;
		if (!target) {
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: "",
				state: "failed",
				outcome: "validation",
				attributes: { error: "path is required" },
				loopId,
			});
			return;
		}
		const normalized = Repository.normalizePath(target);
		const matches = await store.getEntriesByPattern(
			runId,
			normalized,
			entry.attributes.body,
		);

		if (matches.length === 0) {
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: "",
				state: "failed",
				outcome: "not_found",
				attributes: { path: target, error: `${target} not found` },
				loopId,
			});
			return;
		}

		const fileMatches = matches.filter((m) => m.scheme === null);
		const schemeMatches = matches.filter((m) => m.scheme !== null);

		// Scheme entries: remove all, write one aggregate result entry
		for (const match of schemeMatches)
			await store.rm({ runId: runId, path: match.path });
		if (schemeMatches.length > 0) {
			const paths = schemeMatches.map((m) => m.path).join("\n");
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: paths,
				state: "resolved",
				attributes: { path: target },
				loopId,
			});
		}

		// File entries: individual proposals (require user resolution)
		if (fileMatches.length > 0 && schemeMatches.length > 0)
			await store.rm({ runId: runId, path: entry.resultPath });
		for (const match of fileMatches) {
			const resultPath =
				schemeMatches.length === 0 && fileMatches.length === 1
					? entry.resultPath
					: await store.dedup(runId, "rm", match.path, turn);
			await store.set({
				runId,
				turn,
				path: resultPath,
				body: match.path,
				state: "proposed",
				attributes: { path: match.path },
				loopId,
			});
		}
	}

	full(entry) {
		const header = `# rm ${entry.attributes.path || entry.path}`;
		return entry.body ? `${header}\n${entry.body}` : header;
	}

	summary() {
		return "";
	}
}
