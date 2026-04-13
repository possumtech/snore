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

		const line =
			entry.attributes.line != null
				? Math.max(1, parseInt(entry.attributes.line, 10))
				: null;
		const limit =
			entry.attributes.limit != null
				? Math.max(1, parseInt(entry.attributes.limit, 10))
				: null;

		const matches = await store.getEntriesByPattern(
			runId,
			normalized,
			bodyFilter,
		);

		// Partial read — no fidelity promotion, returns a line slice as the log item.
		if (line !== null || limit !== null) {
			if (isPattern) {
				await store.upsert(
					runId,
					turn,
					entry.resultPath,
					"line/limit requires a single path, not a glob or body filter",
					400,
					{ loopId },
				);
				return;
			}
			if (matches.length === 0) {
				await store.upsert(
					runId,
					turn,
					entry.resultPath,
					`${target} not found`,
					200,
					{ loopId },
				);
				return;
			}
			const allLines = matches[0].body.split("\n");
			const total = allLines.length;
			const startLine = line ?? 1;
			const startIdx = startLine - 1;
			const endIdx = limit !== null ? Math.min(startIdx + limit, total) : total;
			const slice = allLines.slice(startIdx, endIdx).join("\n");
			const endLine = endIdx;
			const header = `[lines ${startLine}–${endLine} / ${total} total]`;
			await store.upsert(
				runId,
				turn,
				entry.resultPath,
				`${header}\n${slice}`,
				200,
				{ loopId },
			);
			return;
		}

		const VALID_FIDELITY = {
			summary: 1,
			full: 1,
			archive: 1,
		};
		const fidelityAttr = VALID_FIDELITY[entry.attributes.fidelity]
			? entry.attributes.fidelity
			: null;

		await store.promoteByPattern(runId, normalized, bodyFilter, turn);
		if (fidelityAttr) {
			for (const match of matches)
				await store.setFidelity(runId, match.path, fidelityAttr);
		}

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
			const total = matches.reduce((s, m) => s + m.tokens, 0);
			const paths = matches.map((m) => m.path).join(", ");
			const body =
				matches.length > 0
					? `${paths} promoted to full (${total} tokens)`
					: `${target} not found`;
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
