import Entries from "../../agent/Entries.js";
import { countTokens } from "../../agent/tokens.js";
import Hedberg, { generatePatch } from "../hedberg/hedberg.js";
import { storePatternResult } from "../helpers.js";
import docs from "./setDoc.js";

const VALID_FIDELITY = { archived: 1, demoted: 1, promoted: 1 };

// biome-ignore lint/suspicious/noShadowRestrictedNames: tool name is "set"
export default class Set {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
		core.on("proposal.prepare", this.#materializeRevisions.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.set = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const attrs = entry.attributes;
		const fidelityAttr = VALID_FIDELITY[attrs.fidelity] ? attrs.fidelity : null;
		const rawSummary = typeof attrs.summary === "string" ? attrs.summary : null;
		const summaryText = rawSummary ? rawSummary.slice(0, 80) : null;

		// Pure fidelity/metadata change — no body content
		if (!entry.body && fidelityAttr && attrs.path) {
			const target = attrs.path;
			const matches = await store.getEntriesByPattern(
				runId,
				target,
				attrs.body,
			);
			if (matches.length === 0) {
				await store.set({
					runId,
					turn,
					path: entry.resultPath,
					body: `${target} not found`,
					state: "failed",
					outcome: "not_found",
					fidelity: "archived",
					loopId,
				});
				return;
			}
			for (const match of matches) {
				await store.set({
					runId: runId,
					path: match.path,
					fidelity: fidelityAttr,
				});
				if (summaryText) {
					await store.set({
						runId: runId,
						path: match.path,
						attributes: {
							summary: summaryText,
						},
					});
				}
			}
			const label = `set to ${fidelityAttr}`;
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: `${matches.map((m) => m.path).join(", ")} ${label}`,
				state: "resolved",
				fidelity: "archived",
				loopId,
			});
			return;
		}

		// Edit: sed patterns or SEARCH/REPLACE blocks
		if (attrs.blocks || attrs.search != null) {
			await this.#processEdit(rummy, entry, attrs);
		} else if (attrs.preview && attrs.path) {
			// Preview
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
		} else {
			// Write content
			const target = attrs.path;
			if (!target) return;

			const scheme = Entries.scheme(target);
			if (scheme === null) {
				// File write — diff against existing content
				const existing = await store.getBody(runId, target);
				const oldContent = existing === null ? "" : existing;
				const newContent = entry.body;
				const udiff = generatePatch(target, oldContent, newContent);
				const merge = oldContent
					? `<<<<<<< SEARCH\n${oldContent}\n=======\n${newContent}\n>>>>>>> REPLACE`
					: `<<<<<<< SEARCH\n=======\n${newContent}\n>>>>>>> REPLACE`;
				const beforeTokens = oldContent ? countTokens(oldContent) : 0;
				const afterTokens = countTokens(newContent);
				await store.set({
					runId,
					turn,
					path: entry.resultPath,
					body: newContent,
					state: "proposed",
					attributes: {
						path: target,
						patch: udiff,
						merge,
						beforeTokens,
						afterTokens,
					},
					loopId,
				});
			} else if (attrs.filter || target.includes("*")) {
				// Pattern update
				const matches = await store.getEntriesByPattern(
					runId,
					target,
					attrs.filter,
				);
				await store.set({
					runId: runId,
					path: target,
					body: entry.body,
					bodyFilter: attrs.filter === undefined ? null : attrs.filter,
				});
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
				// Direct scheme write (known://, unknown://, etc.)
				// Same result shape as file writes — diff against existing.
				const existing = await store.getBody(runId, target);
				const oldContent = existing === null ? "" : existing;
				const newContent = entry.body;
				const udiff = generatePatch(target, oldContent, newContent);
				const merge = oldContent
					? `<<<<<<< SEARCH\n${oldContent}\n=======\n${newContent}\n>>>>>>> REPLACE`
					: `<<<<<<< SEARCH\n=======\n${newContent}\n>>>>>>> REPLACE`;
				const beforeTokens = oldContent ? countTokens(oldContent) : 0;
				const afterTokens = countTokens(newContent);

				await store.set({
					runId,
					turn,
					path: target,
					body: newContent,
					state: "resolved",
					// Scheme writes default to promoted — the model wrote it, so
					// it's material unless they explicitly demote/archive.
					fidelity: fidelityAttr ? fidelityAttr : "promoted",
					attributes: summaryText ? { summary: summaryText } : null,
					loopId,
				});
				await store.set({
					runId,
					turn,
					path: entry.resultPath,
					body: newContent,
					state: "resolved",
					loopId,
					attributes: {
						path: target,
						patch: udiff,
						merge,
						beforeTokens,
						afterTokens,
					},
				});
			}
		}

		// Apply fidelity after all write operations
		if (fidelityAttr && attrs.path) {
			const target = attrs.path;
			const scheme = Entries.scheme(target);
			if (scheme !== null) {
				await store.set({ runId: runId, path: target, fidelity: fidelityAttr });
			}
			if (summaryText) {
				await store.set({
					runId: runId,
					path: target,
					attributes: { summary: summaryText },
				});
			}
		}
	}

	full(entry) {
		const attrs = entry.attributes;
		const target = attrs.path || entry.path;
		if (attrs.error) return `# set ${target}\n${attrs.error}`;
		const tokens =
			attrs.beforeTokens != null
				? ` ${attrs.beforeTokens}→${attrs.afterTokens} tokens`
				: "";
		if (!attrs.merge) return `# set ${target}${tokens}`;
		return `# set ${target}${tokens}\n${attrs.merge}`;
	}

	summary() {
		return "";
	}

	async #processEdit(rummy, entry, attrs) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const target = attrs.path;
		const matches = await store.getEntriesByPattern(runId, target, attrs.body);

		if (matches.length === 0) {
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: "",
				state: "failed",
				outcome: "not_found",
				attributes: { path: target, error: `${target} not found in context` },
				loopId,
			});
			return;
		}

		for (const match of matches) {
			if (match.scheme === null) {
				const canonicalPath = `set://${match.path}`;
				const revision = Set.#buildRevision(attrs);
				const existingAttrs = await rummy.getAttributes(canonicalPath);
				const revisions = existingAttrs?.revisions
					? existingAttrs.revisions
					: [];
				revisions.push(revision);
				await store.set({
					runId,
					turn,
					path: canonicalPath,
					body: "",
					state: "resolved",
					attributes: { path: match.path, revisions },
					loopId,
				});
				if (Entries.normalizePath(entry.resultPath) !== canonicalPath) {
					await store.rm({ runId: runId, path: entry.resultPath });
				}
				return;
			}

			const { patch, searchText, replaceText, warning, error } =
				Set.#applyRevision(match.body, attrs);

			const state = error ? "failed" : "resolved";
			const outcome = error ? "conflict" : null;
			const resultPath = `set://${match.path}`;
			const udiff = patch ? generatePatch(match.path, match.body, patch) : null;
			const merge =
				searchText != null
					? `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`
					: null;
			const beforeTokens = match.tokens;
			const afterTokens = patch ? countTokens(patch) : beforeTokens;

			await store.set({
				runId,
				turn,
				path: resultPath,
				body: patch ?? match.body,
				state,
				outcome,
				attributes: {
					path: match.path,
					patch: udiff,
					merge,
					beforeTokens,
					afterTokens,
					warning,
					error,
				},
				loopId,
			});

			if (state === "resolved" && patch) {
				await store.set({
					runId,
					turn,
					path: match.path,
					body: patch,
					state: match.state,
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

			const entryPath = attrs.path;
			const targetEntry = await store.getEntriesByPattern(runId, entryPath);
			if (targetEntry.length === 0) continue;

			const original = targetEntry[0].body;
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

			const state = lastError ? "failed" : "proposed";
			const outcome = lastError ? "conflict" : null;
			const udiff =
				current !== original
					? generatePatch(entryPath, original, current)
					: null;
			const merge = mergeBlocks.length > 0 ? mergeBlocks.join("\n") : null;
			const beforeTokens = targetEntry[0].tokens;
			const afterTokens = current ? countTokens(current) : beforeTokens;

			await store.set({
				runId,
				turn,
				path: entry.path,
				body: current,
				state,
				outcome,
				attributes: {
					path: entryPath,
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

	// `replace` attr is optional in search/replace form — absence means
	// "delete the match"; normalize to empty string at this boundary.
	static #resolveReplace(attrs) {
		return attrs.replace === undefined ? "" : attrs.replace;
	}

	static #buildRevision(attrs) {
		if (attrs.search != null) {
			return { search: attrs.search, replace: Set.#resolveReplace(attrs) };
		}
		if (attrs.blocks?.length > 0) {
			return { blocks: attrs.blocks };
		}
		return null;
	}

	static #applyRevision(body, attrs) {
		if (attrs.search != null) {
			return Hedberg.replace(body, attrs.search, Set.#resolveReplace(attrs), {
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
