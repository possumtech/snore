import Entries from "../../agent/Entries.js";
import { countTokens } from "../../agent/tokens.js";
import Hedberg, { generatePatch } from "../../lib/hedberg/hedberg.js";
import File from "../file/file.js";
import { SUMMARY_MAX_CHARS, storePatternResult } from "../helpers.js";
import docs from "./setDoc.js";

const VALID_VISIBILITY = { archived: 1, summarized: 1, visible: 1 };
const LOG_ACTION_RE = /^log:\/\/turn_\d+\/(\w+)\//;

function isSetProposal(path) {
	const m = LOG_ACTION_RE.exec(path);
	return m?.[1] === "set";
}

// Cap the size of the current-body context surfaced on conflict. Big
// enough for typical known:// entries (plans, notes) and a useful slice
// of files; small enough that a 100k-line file doesn't blow the budget
// on every conflict. The model can `<get>` the path for the full body.
const CONFLICT_FEEDBACK_MAX_CHARS = 4000;
function truncateForFeedback(body) {
	if (body == null) return null;
	if (body.length <= CONFLICT_FEEDBACK_MAX_CHARS) return body;
	const head = body.slice(0, CONFLICT_FEEDBACK_MAX_CHARS);
	return `${head}\n[truncated; ${body.length - CONFLICT_FEEDBACK_MAX_CHARS} more chars — <get> the path for full body]`;
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
		// Materialization is shape-coupled (attrs.path + attrs.patched), not
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
		// authoritative patched body) lands a fresh file body and writes
		// to disk. Lets cp/set/future tools share one materializer.
		if (!attrs?.path || attrs?.patched == null) return;

		const existing = await entries.getBody(runId, attrs.path);
		const isNewFile = existing === null;
		const patched = attrs.patched;
		const turn = (await db.get_run_by_id.get({ id: runId })).next_turn;
		// Visibility precedence: explicit attrs.visibility (mv/cp pass
		// the model's tag attribute through) > current entry visibility
		// (preserves an earlier <get>'s promotion) > scheme default.
		const existingState = await entries.getState(runId, attrs.path);
		const visibility = attrs.visibility
			? attrs.visibility
			: existingState?.visibility;
		await entries.set({
			runId,
			turn,
			path: attrs.path,
			body: patched,
			visibility,
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
		const rawTags = typeof attrs.tags === "string" ? attrs.tags : null;
		const tagsText = rawTags ? rawTags.slice(0, 80) : null;

		// log:// is the immutable record of what happened. Visibility/metadata
		// updates are fine (no body); rewriting the body destroys history.
		// Models reach for this when the Demote example pattern primes
		// `<set ... visibility="summarized">` and they tack on a body line —
		// 405 here teaches the shape that's actually allowed.
		if (attrs.path?.startsWith("log://") && entry.body) {
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath,
				body: `log:// is immutable. To demote: <set path="${attrs.path}" visibility="summarized"/> (no body).`,
				state: "failed",
				outcome: "method_not_allowed",
				attributes: { path: attrs.path },
			});
			return;
		}

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
				if (tagsText) {
					await store.set({
						runId: runId,
						path: match.path,
						attributes: {
							tags: tagsText,
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

		// Build the new content. Either from the marker-parsed operation
		// list (NEW / PREPEND / APPEND / REPLACE / DELETE / SEARCH+REPLACE)
		// or from the plain body (full-replace shorthand).
		const target = attrs.path;
		if (!target) return;
		let newContent;
		if (attrs.operations) {
			const existing = await store.getBody(runId, target);
			const requiresExisting = attrs.operations.some(
				(op) => op.op === "search_replace" || op.op === "delete",
			);
			if (requiresExisting && existing === null) {
				await store.set({
					runId,
					turn,
					loopId,
					path: entry.resultPath,
					body: `${target} not found in context`,
					state: "failed",
					outcome: "not_found",
					attributes: {
						path: target,
						error: `${target} not found in context`,
					},
				});
				return;
			}
			const result = Set.#applyOperations(
				existing == null ? "" : existing,
				attrs.operations,
			);
			if (result.error) {
				await store.set({
					runId,
					turn,
					loopId,
					path: entry.resultPath,
					body: existing == null ? "" : existing,
					state: "failed",
					outcome: "conflict",
					attributes: {
						path: target,
						error: result.error,
						attempted: result.attempted,
						currentBody: truncateForFeedback(existing),
					},
				});
				return;
			}
			newContent = result.body;
		} else if (entry.body) {
			newContent = entry.body;
		}

		if (newContent !== undefined) {
			const scheme = Entries.scheme(target);
			if (scheme === null) {
				// File write — emit a "proposed" entry; #materializeFile
				// writes to disk on accept.
				const existing = await store.getBody(runId, target);
				const oldContent = existing == null ? "" : existing;
				const udiff = generatePatch(target, oldContent, newContent);
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
						patched: newContent,
						beforeTokens,
						afterTokens,
						tags: tagsText,
					},
					loopId,
				});
			} else if (attrs.filter || target.includes("*")) {
				// Pattern body-update: write the same body to every matching
				// entry. Operations don't apply here (this is a bulk
				// metadata-flavored body assignment).
				const matches = await store.getEntriesByPattern(
					runId,
					target,
					attrs.filter,
				);
				await store.set({
					runId: runId,
					path: target,
					body: newContent,
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
				const oldContent = existing == null ? "" : existing;
				const udiff = generatePatch(target, oldContent, newContent);
				const beforeTokens = oldContent ? countTokens(oldContent) : 0;
				const afterTokens = countTokens(newContent);

				await store.set({
					runId,
					turn,
					path: target,
					body: newContent,
					state: "resolved",
					visibility: visibilityAttr ? visibilityAttr : "visible",
					attributes: tagsText ? { tags: tagsText } : null,
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
						beforeTokens,
						afterTokens,
						tags: tagsText,
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
			if (tagsText) {
				await store.set({
					runId: runId,
					path: target,
					attributes: { tags: tagsText },
				});
			}
		}
	}

	full(entry) {
		const attrs = entry.attributes;
		const target = attrs.path || entry.path;
		if (attrs.error) {
			const lines = [`# set ${target}`, attrs.error];
			if (attrs.attempted) {
				lines.push("", "--- attempted ---", attrs.attempted);
			}
			if (attrs.currentBody != null) {
				lines.push("", `--- current body of ${target} ---`, attrs.currentBody);
			}
			return lines.join("\n");
		}
		const tokens =
			attrs.beforeTokens != null
				? ` ${attrs.beforeTokens}→${attrs.afterTokens} tokens`
				: "";
		if (!attrs.patch) return `# set ${target}${tokens}`;
		return `# set ${target}${tokens}\n${attrs.patch}`;
	}

	summary(entry) {
		if (!entry.body) return "";
		// Contract: summarized projections are ≤ SUMMARY_MAX_CHARS. The
		// merge body for an edit can be many KB; truncate. The model
		// reads the full body via promotion to visible if it needs the
		// edit's exact content.
		return entry.body.slice(0, SUMMARY_MAX_CHARS);
	}

	// Walk the parsed marker operation list against a starting body, returning
	// the final body or the first error. SEARCH/REPLACE and DELETE go through
	// Hedberg.replace (fuzzy whitespace match); NEW/REPLACE/PREPEND/APPEND
	// are direct string operations.
	static #applyOperations(currentBody, operations) {
		let body = currentBody;
		for (const op of operations) {
			if (op.op === "new" || op.op === "replace") {
				body = op.content;
			} else if (op.op === "append") {
				body = body + op.content;
			} else if (op.op === "prepend") {
				body = op.content + body;
			} else if (op.op === "delete") {
				const result = Hedberg.replace(body, op.content, "");
				if (result.error) {
					return { body, error: result.error, attempted: op.content };
				}
				body = result.patch;
			} else if (op.op === "search_replace") {
				const result = Hedberg.replace(body, op.search, op.replace);
				if (result.error) {
					return { body, error: result.error, attempted: op.search };
				}
				body = result.patch;
			}
		}
		return { body, error: null, attempted: null };
	}
}
