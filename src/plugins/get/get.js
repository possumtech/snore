import KnownStore from "../../agent/KnownStore.js";
import { storePatternResult } from "../helpers.js";
import docs from "./getDoc.js";

export default class Get {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.get = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const target = entry.attributes.path;
		if (!target) {
			await store.upsert(runId, turn, entry.resultPath, "", "failed", {
				outcome: "validation",
				attributes: { error: "path is required" },
				loopId,
			});
			return;
		}
		const normalized = KnownStore.normalizePath(target);
		const bodyFilter = entry.attributes.body || null;
		const preview = entry.attributes.preview !== undefined;
		const isPattern = bodyFilter || normalized.includes("*");

		// Negative `line` is idiomatic tail-from-end: `line="-50"` means
		// "start 50 lines from the end," enabling `tail -n N` behavior.
		// Positive `line` is 1-indexed from start (classic). `limit` is
		// always a positive count.
		const lineRaw = entry.attributes.line;
		const line = lineRaw != null ? parseInt(lineRaw, 10) : null;
		const limit =
			entry.attributes.limit != null
				? Math.max(1, parseInt(entry.attributes.limit, 10))
				: null;

		const matches = await store.getEntriesByPattern(
			runId,
			normalized,
			bodyFilter,
		);

		// Preview — list matches with their full-body token costs. No promotion,
		// no fidelity change, no Token Budget spent. Model uses this to plan
		// which entries to actually promote. getDoc promises this behavior; the
		// prior implementation silently promoted anyway, burning the Token Budget
		// on entries the model thought it was only inspecting.
		if (preview) {
			await storePatternResult(
				store,
				runId,
				turn,
				"get",
				target,
				bodyFilter,
				matches,
				{ preview: true, loopId, attributes: { path: target } },
			);
			return;
		}

		// Partial read — no fidelity promotion, returns a line slice as the log item.
		if (line !== null || limit !== null) {
			if (isPattern) {
				await store.upsert(
					runId,
					turn,
					entry.resultPath,
					"line/limit requires a single path, not a glob or body filter",
					"failed",
					{
						outcome: "validation",
						loopId,
						attributes: { path: target },
					},
				);
				return;
			}
			if (matches.length === 0) {
				await store.upsert(
					runId,
					turn,
					entry.resultPath,
					`${target} not found`,
					"resolved",
					{ loopId, attributes: { path: target } },
				);
				return;
			}
			const allLines = matches[0].body.split("\n");
			const total = allLines.length;
			// Negative line offsets from the end: line=-50 starts 50 lines
			// before the end. Clamped to 1 if the offset exceeds total.
			const startLine =
				line == null
					? 1
					: line < 0
						? Math.max(1, total + line + 1)
						: Math.max(1, line);
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
				"resolved",
				{ loopId, attributes: { path: target } },
			);
			return;
		}

		const VALID_FIDELITY = {
			demoted: 1,
			promoted: 1,
			archived: 1,
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
				{ loopId, attributes: { path: target } },
			);
		} else {
			const total = matches.reduce((s, m) => s + m.tokens, 0);
			const paths = matches.map((m) => m.path).join(", ");
			const body =
				matches.length > 0
					? `${paths} promoted (${total} tokens)`
					: `${target} not found`;
			await store.upsert(runId, turn, entry.resultPath, body, "resolved", {
				loopId,
				attributes: { path: target },
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
