import KnownStore from "../../agent/KnownStore.js";
import { countTokens } from "../../agent/tokens.js";
import Hedberg, { generatePatch } from "../hedberg/hedberg.js";
import { storePatternResult } from "../helpers.js";
import docs from "./setDoc.js";

const VALID_FIDELITY = { archive: 1, summary: 1, index: 1, full: 1 };

// biome-ignore lint/suspicious/noShadowRestrictedNames: tool name is "set"
export default class Set {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
		core.on("turn.proposing", this.#materializeRevisions.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.set = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const attrs = entry.attributes;

		// Fidelity control: <set path="..." fidelity="archive"/>
		const fidelityAttr = VALID_FIDELITY[attrs.fidelity] ? attrs.fidelity : null;
		if (fidelityAttr && attrs.path) {
			const target = attrs.path;
			const rawSummary =
				typeof attrs.summary === "string" ? attrs.summary : null;
			const summaryText = rawSummary ? rawSummary.slice(0, 80) : null;
			const matches = await store.getEntriesByPattern(
				runId,
				target,
				attrs.body,
			);
			if (entry.body) {
				// Write content directly at specified fidelity
				const entryAttrs = summaryText ? { summary: summaryText } : null;
				for (const match of matches) {
					await store.upsert(runId, turn, match.path, entry.body, 200, {
						fidelity: fidelityAttr,
						attributes: entryAttrs,
						loopId,
					});
				}
				if (matches.length === 0) {
					await store.upsert(runId, turn, target, entry.body, 200, {
						fidelity: fidelityAttr,
						attributes: entryAttrs,
						loopId,
					});
				}
			} else {
				// No body — change fidelity, attach summary if provided
				for (const match of matches) {
					await store.setFidelity(runId, match.path, fidelityAttr);
					if (summaryText) {
						await store.setAttributes(runId, match.path, {
							summary: summaryText,
						});
					}
				}
			}
			if (matches.length === 0) {
				await store.upsert(
					runId,
					turn,
					entry.resultPath,
					`${target} not found`,
					404,
					{
						fidelity: "archive",
						loopId,
					},
				);
				return;
			}
			const label =
				fidelityAttr === "archive" ? "archived" : `set to ${fidelityAttr}`;
			await store.upsert(
				runId,
				turn,
				entry.resultPath,
				`${matches.map((m) => m.path).join(", ")} ${label}`,
				200,
				{
					fidelity: "archive",
					loopId,
				},
			);
			return;
		}

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
				{ preview: true, loopId },
			);
			return;
		}

		const target = attrs.path;
		if (!target) return;

		const scheme = KnownStore.scheme(target);
		if (scheme === null) {
			const udiff = generatePatch(target, "", entry.body || "");
			const merge = `<<<<<<< SEARCH\n=======\n${entry.body || ""}\n>>>>>>> REPLACE`;
			await store.upsert(runId, turn, entry.resultPath, "", 202, {
				attributes: { file: target, patch: udiff, merge },
				loopId,
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
				{ loopId },
			);
		} else {
			await store.upsert(runId, turn, target, entry.body, 200, { loopId });
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

	summary(entry) {
		return entry.attributes.merge || "";
	}

	async #processEdit(rummy, entry, attrs) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const target = attrs.path;
		const matches = await store.getEntriesByPattern(runId, target, attrs.body);

		if (matches.length === 0) {
			await store.upsert(runId, turn, entry.resultPath, "", 404, {
				attributes: { file: target, error: `${target} not found in context` },
				loopId,
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
				await store.upsert(runId, turn, canonicalPath, "", 200, {
					attributes: { file: match.path, revisions },
					loopId,
				});
				if (KnownStore.normalizePath(entry.resultPath) !== canonicalPath) {
					await store.remove(runId, entry.resultPath);
				}
				return;
			}

			const { patch, searchText, replaceText, warning, error } =
				Set.#applyRevision(match.body, attrs);

			const status = error ? 409 : 200;
			const resultPath = `set://${match.path}`;
			const udiff = patch ? generatePatch(match.path, match.body, patch) : null;
			const merge =
				searchText != null
					? `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`
					: null;
			const beforeTokens = match.tokens_full || 0;
			const afterTokens = patch ? countTokens(patch) : beforeTokens;

			await store.upsert(runId, turn, resultPath, match.body, status, {
				attributes: {
					file: match.path,
					patch: udiff,
					merge,
					beforeTokens,
					afterTokens,
					warning,
					error,
				},
				loopId,
			});

			if (status === 200 && patch) {
				await store.upsert(runId, turn, match.path, patch, match.status, {
					loopId,
				});
			}
		}
	}

	async #materializeRevisions({ rummy }) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
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
					Set.#applyRevision(current, rev);

				if (error) lastError = error;
				else if (patch) current = patch;
				if (warning) lastWarning = warning;

				if (searchText != null) {
					mergeBlocks.push(
						`<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`,
					);
				}
			}

			const state = lastError ? 409 : 202;
			const udiff =
				current !== original
					? generatePatch(filePath, original, current)
					: null;
			const merge = mergeBlocks.length > 0 ? mergeBlocks.join("\n") : null;
			const beforeTokens = fileEntry[0].tokens_full || 0;
			const afterTokens = current ? countTokens(current) : beforeTokens;

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
				loopId,
			});
		}
	}

	static #buildRevision(attrs) {
		if (attrs.search != null) {
			return { search: attrs.search, replace: attrs.replace ?? "" };
		}
		if (attrs.blocks?.length > 0) {
			return { blocks: attrs.blocks };
		}
		return null;
	}

	static #applyRevision(body, attrs) {
		if (attrs.search != null) {
			return Hedberg.replace(body, attrs.search, attrs.replace ?? "", {
				sed: attrs.sed,
				flags: attrs.flags,
			});
		}
		if (attrs.blocks?.length > 0 && attrs.blocks[0].search === null) {
			return {
				patch: attrs.blocks[0].replace,
				searchText: null,
				replaceText: attrs.blocks[0].replace,
				warning: null,
				error: null,
			};
		}
		if (body && attrs.blocks?.length > 0) {
			if (attrs.blocks.length === 1) {
				const block = attrs.blocks[0];
				return Hedberg.replace(body, block.search, block.replace, {
					sed: block.sed,
					flags: block.flags,
				});
			}
			// Multi-block: apply sequentially, no per-hunk merge notation
			let current = body;
			let lastWarning = null;
			for (const block of attrs.blocks) {
				const result = Hedberg.replace(current, block.search, block.replace, {
					sed: block.sed,
					flags: block.flags,
				});
				if (result.error) return result;
				if (result.warning) lastWarning = result.warning;
				if (result.patch) current = result.patch;
			}
			return {
				patch: current !== body ? current : null,
				searchText: null,
				replaceText: null,
				warning: lastWarning,
				error: null,
			};
		}
		return {
			patch: null,
			searchText: null,
			replaceText: null,
			warning: null,
			error: null,
		};
	}
}
