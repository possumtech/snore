import Entries from "../../agent/Entries.js";
import { countTokens } from "../../agent/tokens.js";
import Hedberg, { generatePatch } from "../../lib/hedberg/hedberg.js";
import { applyMerge, buildMerge } from "../../lib/hedberg/merge.js";
import File from "../file/file.js";
import { SUMMARY_MAX_CHARS, storePatternResult } from "../helpers.js";
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
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.set = docs;
			return docsMap;
		});
		core.filter("proposal.accepting", this.#vetoReadonly.bind(this));
		core.filter("proposal.content", this.#preferExistingBody.bind(this));
		// Materialization is shape-coupled (attrs.path + attrs.merge), not
		// path-coupled. Any plugin emitting a proposal in that shape
		// (set, cp, future tools) gets fs materialization for free.
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
		const { attrs, runId, projectId, projectRoot, db, entries } = ctx;
		// Shape gate, not path gate: any accepted proposal whose
		// attributes describe a file materialization (target path +
		// SEARCH/REPLACE merge) lands a fresh file body and writes to
		// disk. Lets cp/set/future tools share one materializer.
		if (!attrs?.path || !attrs?.merge) return;

		const existing = await entries.getBody(runId, attrs.path);
		const isNewFile = existing === null;
		const fileBody = isNewFile ? "" : existing;
		const patched = applyMerge(fileBody, attrs.merge);
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
			const { writeFile, mkdir } = await import("node:fs/promises");
			const { dirname, isAbsolute, join } = await import("node:path");
			const targetPath = isAbsolute(attrs.path)
				? attrs.path
				: join(projectRoot, attrs.path);
			await mkdir(dirname(targetPath), { recursive: true });
			await writeFile(targetPath, patched);
		}
		if (isNewFile && projectId) {
			await File.setConstraint(db, projectId, attrs.path, "add");
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

		// Refuse parse-error edits (e.g., malformed sed). Without this the
		// XmlParser would have either silently produced a corrupted edit
		// or fallen through to body-replace, overwriting the target with
		// the literal sed text. Surfacing the error gives the model a
		// concrete signal it can adapt to.
		if (attrs.error) {
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath,
				body: attrs.error,
				state: "failed",
				outcome: "validation",
				attributes: { path: attrs.path, error: attrs.error },
			});
			return;
		}

		// Manifest: universal preview gate. Fires before any operational
		// branch so visibility flips, SEARCH/REPLACE edits, sed substitutions,
		// pattern writes, and direct writes all support
		// "list-without-doing" with the same flag.
		if (attrs.manifest !== undefined && attrs.path) {
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
				{ manifest: true, loopId, attributes: { path: attrs.path } },
			);
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
				const merge = buildMerge(oldContent, newContent);
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
				const merge = buildMerge(oldContent, newContent);
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
		// Contract: summarized projections are ≤ SUMMARY_MAX_CHARS. The
		// merge body for an edit can be many KB; truncate. The model
		// reads the full body via promotion to visible if it needs the
		// edit's exact content.
		return entry.body.slice(0, SUMMARY_MAX_CHARS);
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
				// Bare file: emit a "proposed" log entry whose attrs carry
				// the merge. yolo (or manual accept) → proposal.accepted →
				// materializeFile applies the merge and writes to disk.
				// Each edit is its own proposal — predictable, parallel-
				// friendly, no cross-turn canonical-entry state to leak.
				const { patch, searchText, replaceText, warning, error } =
					Set.#applyRevision(match.body, attrs);
				const merge =
					searchText != null ? buildMerge(searchText, replaceText) : null;
				const beforeTokens = match.tokens;
				const afterTokens = patch ? countTokens(patch) : beforeTokens;
				const logState = error ? "failed" : "proposed";
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
				searchText != null ? buildMerge(searchText, replaceText) : null;
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

	// Missing `replace` = delete the match; normalize to empty string.
	static #resolveReplace(attrs) {
		return attrs.replace === undefined ? "" : attrs.replace;
	}

	static #applyRevision(body, attrs) {
		if (attrs.search != null) {
			return Hedberg.replace(body, attrs.search, Set.#resolveReplace(attrs), {
				sed: attrs.sed,
				flags: attrs.flags,
			});
		}
		// Empty SEARCH section = creation form. Replace is the entire new
		// body; no matching against existing content.
		if (attrs.blocks?.length > 0 && !attrs.blocks[0].search) {
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
