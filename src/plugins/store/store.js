import { readFileSync } from "node:fs";
import { storePatternResult } from "../helpers.js";

export default class Store {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({ validStates: ["full", "stored", "pattern"] });
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
		const bodyFilter = entry.attributes.body || null;
		const isPattern = bodyFilter || target.includes("*");
		const matches = await store.getEntriesByPattern(runId, target, bodyFilter);
		await store.demoteByPattern(runId, target, bodyFilter);

		if (isPattern) {
			await storePatternResult(
				store,
				runId,
				turn,
				"store",
				target,
				bodyFilter,
				matches,
				{ loopId },
			);
		} else {
			const paths = matches.map((m) => m.path).join(", ");
			const body =
				matches.length > 0 ? `${paths} stored` : `${target} not found`;
			await store.upsert(runId, turn, entry.resultPath, body, "stored", {
				loopId,
			});
		}
	}

	full(entry) {
		return `# store ${entry.attributes.path || entry.path}`;
	}

	summary(entry) {
		return this.full(entry);
	}
}
