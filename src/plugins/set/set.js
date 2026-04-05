import KnownStore from "../../agent/KnownStore.js";
import { storePatternResult } from "../helpers.js";
import HeuristicMatcher, { generatePatch } from "./HeuristicMatcher.js";

// biome-ignore lint/suspicious/noShadowRestrictedNames: tool name is "set"
export default class Set {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.on("turn.proposing", this.#materializeRevisions.bind(this));
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId } = rummy;
		const attrs = entry.attributes;

		if (attrs.blocks || attrs.search != null) {
			await this.#processEdit(rummy, entry, attrs);
			return;
		}

		if (attrs.preview && attrs.path) {
			const matches = await store.getEntriesByPattern(
				runId,
				attrs.path,
				attrs.body,
			);
			await storePatternResult(
				store,
				runId,
				turn,
				"set",
				attrs.path,
				attrs.body,
				matches,
				true,
			);
			return;
		}

		const target = attrs.path;
		if (!target) return;

		const scheme = KnownStore.scheme(target);
		if (scheme === null) {
			const udiff = generatePatch(target, "", entry.body || "");
			const merge = `<<<<<<< SEARCH\n=======\n${entry.body || ""}\n>>>>>>> REPLACE`;
			await store.upsert(runId, turn, entry.resultPath, "", "proposed", {
				attributes: { file: target, patch: udiff, merge },
			});
		} else if (attrs.filter || target.includes("*")) {
			const matches = await store.getEntriesByPattern(
				runId,
				target,
				attrs.filter,
			);
			await store.updateBodyByPattern(
				runId,
				target,
				attrs.filter || null,
				entry.body,
			);
			await storePatternResult(
				store,
				runId,
				turn,
				"set",
				target,
				attrs.filter,
				matches,
			);
		} else {
			await store.upsert(runId, turn, target, entry.body, "full");
		}
	}

	full(entry) {
		const attrs = entry.attributes;
		const file = attrs.file || entry.path;
		if (attrs.error) return `# set ${file}\n${attrs.error}`;
		const tokens =
			attrs.beforeTokens != null
				? ` ${attrs.beforeTokens}→${attrs.afterTokens} tokens`
				: "";
		if (!attrs.merge) return `# set ${file}${tokens}`;
		return `# set ${file}${tokens}\n${attrs.merge}`;
	}

	async #processEdit(rummy, entry, attrs) {
		const { entries: store, sequence: turn, runId } = rummy;
		const target = attrs.path;
		const matches = await store.getEntriesByPattern(runId, target, attrs.body);

		if (matches.length === 0) {
			await store.upsert(runId, turn, entry.resultPath, "", "error", {
				attributes: { file: target, error: `${target} not found in context` },
			});
			return;
		}

		for (const match of matches) {
			if (match.scheme === null) {
				const canonicalPath = `set://${match.path}`;
				const revision = Set.#buildRevision(attrs);
				const existingAttrs = await rummy.getAttributes(canonicalPath);
				const revisions = existingAttrs?.revisions || [];
				revisions.push(revision);
				await store.upsert(runId, turn, canonicalPath, "", "full", {
					attributes: { file: match.path, revisions },
				});
				if (KnownStore.normalizePath(entry.resultPath) !== canonicalPath) {
					await store.remove(runId, entry.resultPath);
				}
				return;
			}

			const { patch, searchText, replaceText, warning, error } = Set.#applyEdit(
				match.body,
				attrs,
			);

			const state = error ? "error" : "pass";
			const resultPath = `set://${match.path}`;
			const udiff = patch ? generatePatch(match.path, match.body, patch) : null;
			const merge =
				searchText != null
					? `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`
					: null;
			const beforeTokens = match.tokens_full || 0;
			const afterTokens = patch ? (patch.length / 4) | 0 : beforeTokens;

			await store.upsert(runId, turn, resultPath, match.body, state, {
				attributes: {
					file: match.path,
					patch: udiff,
					merge,
					beforeTokens,
					afterTokens,
					warning,
					error,
				},
			});

			if (state === "pass" && patch) {
				await store.upsert(runId, turn, match.path, patch, match.state);
			}
		}
	}

	async #materializeRevisions({ rummy }) {
		const { entries: store, sequence: turn, runId } = rummy;
		const setEntries = await store.getEntriesByPattern(runId, "set://*");

		for (const entry of setEntries) {
			const attrs =
				typeof entry.attributes === "string"
					? JSON.parse(entry.attributes)
					: entry.attributes;
			if (!attrs?.revisions?.length) continue;

			const filePath = attrs.file;
			const fileEntry = await store.getEntriesByPattern(runId, filePath);
			if (fileEntry.length === 0) continue;

			const original = fileEntry[0].body;
			let current = original;
			const mergeBlocks = [];
			let lastError = null;
			let lastWarning = null;

			for (const rev of attrs.revisions) {
				if (!rev) continue;
				const { patch, searchText, replaceText, warning, error } =
					Set.#applyEdit(current, { search: rev.search, replace: rev.replace });

				if (error) lastError = error;
				else if (patch) current = patch;
				if (warning) lastWarning = warning;

				if (searchText != null) {
					mergeBlocks.push(
						`<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`,
					);
				}
			}

			const state = lastError ? "error" : "proposed";
			const udiff =
				current !== original
					? generatePatch(filePath, original, current)
					: null;
			const merge = mergeBlocks.length > 0 ? mergeBlocks.join("\n") : null;
			const beforeTokens = fileEntry[0].tokens_full || 0;
			const afterTokens = current ? (current.length / 4) | 0 : beforeTokens;

			await store.upsert(runId, turn, entry.path, original, state, {
				attributes: {
					file: filePath,
					patch: udiff,
					merge,
					beforeTokens,
					afterTokens,
					warning: lastWarning,
					error: lastError,
				},
			});
		}
	}

	static #buildRevision(attrs) {
		if (attrs.search != null) {
			return { search: attrs.search, replace: attrs.replace ?? "" };
		}
		if (attrs.blocks?.length > 0) {
			return {
				search: attrs.blocks[0].search,
				replace: attrs.blocks[0].replace,
			};
		}
		return null;
	}

	static #applyEdit(body, attrs) {
		let patch = null;
		let warning = null;
		let error = null;
		let searchText = null;
		let replaceText = null;

		if (attrs.search != null) {
			searchText = attrs.search;
			replaceText = attrs.replace ?? "";
			if (body.includes(attrs.search)) {
				patch = body.replaceAll(attrs.search, replaceText);
			} else {
				const matched = HeuristicMatcher.matchAndPatch(
					"",
					body,
					attrs.search,
					replaceText,
				);
				patch = matched.newContent;
				warning = matched.warning;
				error = matched.error;
			}
		} else if (attrs.blocks?.length > 0 && attrs.blocks[0].search === null) {
			patch = attrs.blocks[0].replace;
			replaceText = attrs.blocks[0].replace;
		} else if (body && attrs.blocks?.length > 0) {
			const block = attrs.blocks[0];
			searchText = block.search;
			replaceText = block.replace;
			const matched = HeuristicMatcher.matchAndPatch(
				"",
				body,
				block.search,
				block.replace,
			);
			patch = matched.newContent;
			warning = matched.warning;
			error = matched.error;
		}

		return { patch, searchText, replaceText, warning, error };
	}
}
