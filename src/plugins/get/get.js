import { readFileSync } from "node:fs";
import KnownStore from "../../agent/KnownStore.js";
import { storePatternResult } from "../helpers.js";

export default class Get {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
		const docs = readFileSync(new URL("./docs.md", import.meta.url), "utf8");
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

		// Budget check — reject if loading would exceed context
		const contextSize = rummy.contextSize;
		if (contextSize && matches.length > 0) {
			const incomingTokens = matches.reduce((s, m) => s + m.tokens_full, 0);
			const currentUsage = (
				await rummy.db.get_promoted_token_total.get({ run_id: runId })
			).total;
			const remaining = Math.floor(contextSize * 0.95) - currentUsage;
			if (incomingTokens > remaining) {
				await store.upsert(runId, turn, entry.resultPath, "", 413, {
					attributes: {
						error: `${matches.length} entries (${incomingTokens} tokens) exceeds available context (${remaining} tokens remaining). Use <set path="..." stored/> to archive or <rm/> to free space, or <get path="..." preview/> to list without loading.`,
					},
					loopId,
				});
				return;
			}
		}

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
