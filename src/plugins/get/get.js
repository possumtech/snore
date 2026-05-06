import Entries from "../../agent/Entries.js";
import { storePatternResult } from "../helpers.js";
import docs from "./getDoc.js";

export default class Get {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.get = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		// Search-by-tags: same `tags` attribute that <set> writes onto
		// entries. Same name on both ends — no in/out semantic split.
		const tagsAttr = entry.attributes.tags;
		// Tags-only get defaults path to "**" so the model can recall by
		// folksonomic tags without remembering exact paths.
		const target = entry.attributes.path || (tagsAttr ? "**" : null);
		if (!target) {
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath,
				body: 'Missing required "path" attribute on <get>. Use <get path="..."/>.',
				state: "failed",
				outcome: "validation",
			});
			return;
		}
		const normalized = Entries.normalizePath(target);
		const bodyFilter = entry.attributes.body;
		const manifest = entry.attributes.manifest !== undefined;
		const wantedTags = tagsAttr
			? tagsAttr
					.split(",")
					.map((t) => t.trim().toLowerCase())
					.filter(Boolean)
			: null;
		const isPattern = bodyFilter || normalized.includes("*") || !!wantedTags;

		// Negative line = tail-from-end (line=-50 starts 50 from end).
		const lineRaw = entry.attributes.line;
		const line = lineRaw != null ? parseInt(lineRaw, 10) : null;
		const limit =
			entry.attributes.limit != null
				? Math.max(1, parseInt(entry.attributes.limit, 10))
				: null;

		let matches = await store.getEntriesByPattern(
			runId,
			normalized,
			bodyFilter,
		);
		if (wantedTags) {
			matches = matches.filter((e) => {
				if (!e.attributes) return false;
				const attrs =
					typeof e.attributes === "string"
						? JSON.parse(e.attributes)
						: e.attributes;
				if (typeof attrs.tags !== "string") return false;
				const tags = attrs.tags.toLowerCase();
				return wantedTags.every((t) => tags.includes(t));
			});
		}

		// Manifest: list matches + full-body token costs; no promotion.
		if (manifest) {
			await storePatternResult(
				store,
				runId,
				turn,
				"get",
				target,
				bodyFilter,
				matches,
				{ manifest: true, loopId, attributes: { path: target } },
			);
			return;
		}

		// Partial read: line slice in the log entry; no promotion.
		if (line !== null || limit !== null) {
			if (isPattern) {
				await store.set({
					runId,
					turn,
					path: entry.resultPath,
					body: "line/limit requires a single path, not a glob or body filter",
					state: "failed",
					outcome: "validation",
					loopId,
					attributes: { path: target },
				});
				return;
			}
			if (matches.length === 0) {
				await store.set({
					runId,
					turn,
					path: entry.resultPath,
					body: `${target} not found`,
					state: "resolved",
					loopId,
					attributes: { path: target },
				});
				return;
			}
			const allLines = matches[0].body.split("\n");
			const total = allLines.length;
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
			const header = `${target}\n[lines ${startLine}–${endLine} / ${total} total]`;
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: `${header}\n${slice}`,
				state: "resolved",
				loopId,
				attributes: {
					path: target,
					lineStart: startLine,
					lineEnd: endLine,
					totalLines: total,
				},
			});
			return;
		}

		const VALID_VISIBILITY = {
			summarized: 1,
			visible: 1,
			archived: 1,
		};
		const visibilityAttr = VALID_VISIBILITY[entry.attributes.visibility]
			? entry.attributes.visibility
			: null;

		await store.get({
			runId: runId,
			turn: turn,
			path: normalized,
			bodyFilter: bodyFilter,
		});
		if (visibilityAttr) {
			for (const match of matches)
				await store.set({
					runId: runId,
					path: match.path,
					visibility: visibilityAttr,
				});
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
		} else if (matches.length === 0) {
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: `${target} not found`,
				state: "resolved",
				loopId,
				attributes: { path: target },
			});
		} else {
			// Log line in <log> proves the promotion happened so the model doesn't re-fetch.
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: `${target} promoted`,
				state: "resolved",
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
