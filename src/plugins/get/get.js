import { readFileSync } from "node:fs";
import { storePatternResult } from "../helpers.js";

export default class Get {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({ validStates: ["full", "read", "pattern"] });
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
		if (!target) return;
		const bodyFilter = entry.attributes.body || null;
		const isPattern = bodyFilter || target.includes("*");
		const matches = await store.getEntriesByPattern(runId, target, bodyFilter);
		await store.promoteByPattern(runId, target, bodyFilter, turn);

		if (isPattern) {
			await storePatternResult(
				store,
				runId,
				turn,
				"get",
				target,
				bodyFilter,
				matches,
				{ loopId },
			);
		} else {
			const total = matches.reduce((s, m) => s + m.tokens_full, 0);
			const paths = matches.map((m) => m.path).join(", ");
			const body =
				matches.length > 0 ? `${paths} ${total} tokens` : `${target} not found`;
			await store.upsert(runId, turn, entry.resultPath, body, "read", {
				loopId,
			});
		}
	}

	full(entry) {
		return `# get ${entry.attributes.path || entry.path}\n${entry.body}`;
	}

	summary() {
		return "";
	}
}
