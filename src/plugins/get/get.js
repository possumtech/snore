import KnownStore from "../../agent/KnownStore.js";
import { storePatternResult } from "../helpers.js";
import docs from "./getDoc.js";

export default class Get {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.get = docs;
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
		const bodyFilter = entry.attributes.body || null;
		const isPattern = bodyFilter || normalized.includes("*");
		const matches = await store.getEntriesByPattern(
			runId,
			normalized,
			bodyFilter,
		);

		await store.promoteByPattern(runId, normalized, bodyFilter, turn);

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
			await store.upsert(runId, turn, entry.resultPath, body, 200, {
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
