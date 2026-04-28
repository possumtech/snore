import Entries from "../../agent/Entries.js";
import { countTokens } from "../../agent/tokens.js";
import File from "../file/file.js";
import Hedberg, { generatePatch } from "../hedberg/hedberg.js";
import { storePatternResult } from "../helpers.js";
import docs from "./setDoc.js";

const VALID_VISIBILITY = { archived: 1, summarized: 1, visible: 1 };
const LOG_ACTION_RE = /^log:\/\/turn_\d+\/(\w+)\//;

function isSetProposal(path) {
	const m = LOG_ACTION_RE.exec(path);
	return m?.[1] === "set";
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: tool name is "set"
export default class Set {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
		core.on("proposal.prepare", this.#materializeRevisions.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.set = docs;
			return docsMap;
		});
		core.filter("proposal.accepting", this.#vetoReadonly.bind(this));
		core.filter("proposal.content", this.#preferExistingBody.bind(this));
		core.on("proposal.accepted", this.#materializeFile.bind(this));
	}

	async #vetoReadonly(current, ctx) {
		if (current) return current;
		if (!isSetProposal(ctx.path)) return current;
		if (!ctx.attrs?.path) return current;
		const blocked = await File.isReadonly(
			ctx.db,
			ctx.projectId,
			ctx.attrs.path,
		);
		if (!blocked) return current;
		return {
			allow: false,
			outcome: "readonly",
			body: `refused: ${ctx.attrs.path} is readonly`,
		};
	}

	async #preferExistingBody(defaultBody, ctx) {
		if (!isSetProposal(ctx.path)) return defaultBody;
		const existing = await ctx.entries.getBody(ctx.runId, ctx.path);
		if (existing) return existing;
		return defaultBody;
	}

	async #materializeFile(ctx) {
		if (!isSetProposal(ctx.path)) return;
		const { attrs, runId, projectId, projectRoot, db, entries } = ctx;
		if (!attrs?.path || !attrs?.merge) return;

		const existing = await entries.getBody(runId, attrs.path);
		const isNewFile = existing === null;
		const fileBody = isNewFile ? "" : existing;
		const blocks = attrs.merge.split(/(?=<<<<<<< SEARCH)/);
		let patched = fileBody;
		for (const block of blocks) {
			const m = block.match(
				/<<<<<<< SEARCH\n?([\s\S]*?)\n?=======\n?([\s\S]*?)\n?>>>>>>> REPLACE/,
			);
			if (!m) continue;
			if (m[1] === "") {
				patched = m[2];
			} else {
				patched = patched.replace(m[1], m[2]);
			}
		}
		const turn = (await db.get_run_by_id.get({ id: runId })).next_turn;
		// Preserve current visibility; default would wipe an earlier <get>'s promotion.
		const existingState = await entries.getState(runId, attrs.path);
		await entries.set({
			runId,
			turn,
			path: attrs.path,
			body: patched,
			visibility: existingState?.visibility,
		});
		if (projectRoot) {
			const { writeFile } = await import("node:fs/promises");
			const { join } = await import("node:path");
			await writeFile(join(projectRoot, attrs.path), patched).catch(() => {});
		}
		if (isNewFile && projectId) {
			await File.setConstraint(db, projectId, attrs.path, "active");
		}
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const attrs = entry.attributes;
		const visibilityAttr = VALID_VISIBILITY[attrs.visibility]
			? attrs.visibility
			: null;
		const rawSummary = typeof attrs.summary === "string" ? attrs.summary : null;
		const summaryText = rawSummary ? rawSummary.slice(0, 80) : null;

		// Reject invalid visibility on body-less set; otherwise a typo silently wipes the body.
		if (
			!entry.body &&
			attrs.path &&
			attrs.visibility !== undefined &&
			!visibilityAttr
		) {
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath,
				body: `Invalid visibility "${attrs.visibility}" on <set path="${attrs.path}"/>. Use visibility="visible|summarized|archived".`,
				state: "failed",
				outcome: "validation",
				attributes: { path: attrs.path },
			});
			return;
		}

		// Pure visibility/metadata change — no body content
		if (!entry.body && visibilityAttr && attrs.path) {
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
					visibility: "archived",
					loopId,
				});
				return;
			}
			for (const match of matches) {
				await store.set({
					runId: runId,
					path: match.path,
					visibility: visibilityAttr,
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
			const label = `set to ${visibilityAttr}`;
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
				body: `${matches.map((m) => m.path).join(", ")} ${label}`,
				state: "resolved",
				visibility: "archived",
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
						summary: summaryText,
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
				// Direct scheme write; same diff-against-existing shape as file writes.
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
					// Scheme writes default visible; the model wrote it.
					visibility: visibilityAttr ? visibilityAttr : "visible",
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
						summary: summaryText,
					},
				});
			}
		}

		// Apply visibility after all write operations
		if (visibilityAttr && attrs.path) {
			const target = attrs.path;
			const scheme = Entries.scheme(target);
			if (scheme !== null) {
				await store.set({
					runId: runId,
					path: target,
					visibility: visibilityAttr,
				});
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

	summary(entry) {
		if (!entry.body) return "";
		// Preserve SEARCH/REPLACE blocks intact; truncation strips before/after the model needs.
		if (/<<<<<<< SEARCH[\s\S]*>>>>>>> REPLACE/.test(entry.body)) {
			return entry.body;
		}
		const flat = entry.body.replace(/\s+/g, " ").trim();
		return flat.length <= 80 ? flat : `${flat.slice(0, 77)}...`;
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
				// Bare file: apply edit immediately so log carries before/after merge.
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
				const { patch, searchText, replaceText, warning, error } =
					Set.#applyRevision(match.body, attrs);
				const merge =
					searchText != null
						? `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`
						: null;
				const beforeTokens = match.tokens;
				const afterTokens = patch ? countTokens(patch) : beforeTokens;
				const logState = error ? "failed" : "resolved";
				await store.set({
					runId,
					turn,
					path: entry.resultPath,
					body: merge ?? (patch || `edit to ${match.path}`),
					state: logState,
					outcome: error ? "conflict" : null,
					attributes: {
						path: match.path,
						merge,
						beforeTokens,
						afterTokens,
						warning,
						error,
					},
					loopId,
				});
				return;
			}

			const { patch, searchText, replaceText, warning, error } =
				Set.#applyRevision(match.body, attrs);

			const state = error ? "failed" : "resolved";
			const outcome = error ? "conflict" : null;
			const udiff = patch ? generatePatch(match.path, match.body, patch) : null;
			const merge =
				searchText != null
					? `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`
					: null;
			const beforeTokens = match.tokens;
			const afterTokens = patch ? countTokens(patch) : beforeTokens;

			// Log entry at log://turn_N/set/<target> records the action.
			await store.set({
				runId,
				turn,
				path: entry.resultPath,
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

	// Missing `replace` = delete the match; normalize to empty string.
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
