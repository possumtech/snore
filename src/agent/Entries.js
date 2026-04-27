import slugify from "../sql/functions/slugify.js";
import { PermissionError } from "./errors.js";

export default class Entries {
	#db;
	#onChanged;
	#schemes = new Map();
	#schemesLoaded = null;
	#seq = 0;
	#pendingResolutions = new Map();

	constructor(db, { onChanged = null } = {}) {
		this.#db = db;
		this.#onChanged = onChanged;
	}

	/**
	 * Populate the scheme cache. Can be called explicitly (e.g. at boot
	 * after initPlugins finishes) or runs lazily on first need. Idempotent.
	 */
	async loadSchemes(db) {
		const rows = await (db || this.#db).get_all_schemes.all();
		this.#schemes.clear();
		for (const row of rows) {
			this.#schemes.set(row.name, row);
		}
	}

	async #ensureSchemes() {
		if (!this.#schemesLoaded) {
			this.#schemesLoaded = this.loadSchemes();
		}
		return this.#schemesLoaded;
	}

	#emitChanged(runId, path, changeType) {
		if (this.#onChanged) this.#onChanged({ runId, path, changeType });
	}

	static scheme(path) {
		if (!path) return null;
		const idx = path.indexOf("://");
		return idx > 0 ? path.slice(0, idx) : null;
	}

	static normalizePath(path) {
		if (!path?.includes("://")) return path;
		const sep = path.indexOf("://");
		const scheme = path.slice(0, sep).toLowerCase();
		const rest = path.slice(sep + 3);
		try {
			// Decode first (idempotent), then encode — but preserve slashes
			const decoded = decodeURIComponent(rest);
			return `${scheme}://${decoded.split("/").map(encodeURIComponent).join("/")}`;
		} catch {
			return `${scheme}://${rest.split("/").map(encodeURIComponent).join("/")}`;
		}
	}

	async nextTurn(runId) {
		const row = await this.#db.next_turn.get({ run_id: runId });
		return row.turn;
	}

	async dedup(runId, scheme, target, turn) {
		const encodedTarget = encodeURIComponent(target);
		const turnPrefix = turn ? `turn_${turn}/` : "";
		const candidate = `${scheme}://${turnPrefix}${encodedTarget}`;
		const existing = await this.#db.get_entry_body.get({
			run_id: runId,
			path: candidate,
		});
		if (!existing) return candidate;
		return `${candidate}_${++this.#seq}`;
	}

	// Log entries share a single namespace at log://turn_N/action/slug.
	// The action segment is the tool/plugin name (set, get, search, update,
	// error, etc.). Target is URL-encoded so slashes and scheme separators
	// survive round-trips.
	async logPath(runId, turn, action, target) {
		const encodedTarget = encodeURIComponent(target);
		const candidate = `log://turn_${turn}/${action}/${encodedTarget}`;
		const existing = await this.#db.get_entry_body.get({
			run_id: runId,
			path: candidate,
		});
		if (!existing) return candidate;
		return `${candidate}_${++this.#seq}`;
	}

	async slugPath(runId, scheme, content, summary) {
		// Prefer summary, fall back to body content, then empty — slugify
		// handles empty explicitly by returning "" and the caller generates
		// a sequence-only path.
		let source = "";
		if (summary) source = summary;
		else if (content) source = content;
		const base = slugify(source);
		const prefix = `${scheme}://`;

		if (!base) return `${prefix}${++this.#seq}`;

		const candidate = `${prefix}${base}`;
		const existing = await this.#db.get_entry_body.get({
			run_id: runId,
			path: candidate,
		});
		if (!existing) return candidate;

		return `${prefix}${base}_${++this.#seq}`;
	}

	/**
	 * Resolve a scheme's declared scope kind + writer list + category.
	 * Unregistered or declaration-less schemes default to run-level +
	 * model/plugin writers so ad-hoc paths (e.g. bare filenames) still
	 * work.
	 */
	async #schemeRules(scheme) {
		await this.#ensureSchemes();
		const row = scheme ? this.#schemes.get(scheme) : null;
		const kind = row?.default_scope ? row.default_scope : "run";
		const category = row?.category ? row.category : "logging";
		let writers = ["model", "plugin"];
		if (row?.writable_by) {
			const parsed =
				typeof row.writable_by === "string"
					? JSON.parse(row.writable_by)
					: row.writable_by;
			if (Array.isArray(parsed)) writers = parsed;
		}
		return { kind, writers, category };
	}

	#defaultVisibility(scheme, category) {
		if (scheme === "skill") return "visible";
		if (category === "prompt") return "visible";
		if (category === "unknown") return "visible";
		if (category === "logging") return "visible";
		return "summarized";
	}

	#resolveScope(kind, runId, projectId) {
		if (kind === "global") return "global";
		if (kind === "project") {
			if (!projectId) {
				throw new Error(
					"project-scoped write requires projectId; caller must pass it to set()",
				);
			}
			return `project:${projectId}`;
		}
		return `run:${runId}`;
	}

	/**
	 * set — create or update an entry. The semantically wide primitive.
	 *
	 * Modes (selected by which options are present):
	 *   — write content:         body given, state ∈ {proposed,streaming,resolved,failed,cancelled}
	 *   — change visibility only:  visibility given, body omitted
	 *   — change state only:     state given, body omitted (resolve a proposal)
	 *   — merge attributes:      attributes given, body omitted
	 *   — append to body:        append:true (streaming)
	 *   — pattern match:         path contains wildcards or bodyFilter set
	 */
	async set({
		runId,
		projectId = null,
		turn = 0,
		path,
		body,
		state,
		visibility,
		outcome = null,
		attributes,
		append,
		bodyFilter = null,
		pattern,
		hash = null,
		loopId = null,
		writer = "plugin",
	}) {
		if (!runId) throw new Error("set: runId is required");
		if (!path) throw new Error("set: path is required");

		// Pattern mode is explicit (pattern: true) or implicit when a
		// body filter is supplied. The literal `*` character can appear
		// inside legitimate exact paths (e.g. rm://foo%2F* as a result
		// path for an rm against a pattern); we don't infer pattern mode
		// from the path alone.
		const isPattern = pattern === true || bodyFilter !== null;

		// Pattern mode: update matching entries (visibility / body / both).
		if (isPattern) {
			if (body != null && !append) {
				await this.#db.update_body_by_pattern.run({
					run_id: runId,
					path,
					body: bodyFilter,
					new_body: body,
				});
				await this.#db.bump_write_count_by_pattern.run({
					run_id: runId,
					path,
					body: bodyFilter,
				});
				this.#emitChanged(runId, path, "body");
			}
			if (visibility === "visible") {
				await this.#db.promote_by_pattern.run({
					run_id: runId,
					path,
					body: bodyFilter,
					turn,
				});
				this.#emitChanged(runId, path, "promote");
			} else if (visibility === "summarized" || visibility === "archived") {
				await this.#db.demote_by_pattern.run({
					run_id: runId,
					path,
					body: bodyFilter,
				});
				this.#emitChanged(runId, path, "demote");
			}
			return;
		}

		const normalized = Entries.normalizePath(path);
		const scheme = Entries.scheme(normalized);

		// Append mode: streaming body growth on an existing entry.
		if (append) {
			if (body == null) throw new Error("set: append requires body");
			await this.#db.append_entry_body.run({
				run_id: runId,
				path: normalized,
				chunk: body,
			});
			this.#emitChanged(runId, normalized, "append");
			return;
		}

		// Body-less state or visibility change on an existing entry.
		if (body == null) {
			if (state != null) {
				await this.#db.resolve_known_entry_view.run({
					run_id: runId,
					path: normalized,
					state,
					outcome,
				});
				this.#emitChanged(runId, normalized, "resolve");
				this.#drainPendingResolution(runId, normalized);
			}
			if (visibility != null) {
				await this.#db.set_visibility.run({
					run_id: runId,
					path: normalized,
					visibility,
				});
				this.#emitChanged(runId, normalized, "visibility");
			}
			if (attributes != null) {
				await this.#db.update_entry_attributes.run({
					run_id: runId,
					path: normalized,
					attributes: JSON.stringify(attributes),
				});
				this.#emitChanged(runId, normalized, "attributes");
			}
			return;
		}

		// Full write/upsert: body + state + visibility + attributes.
		const { kind, writers, category } = await this.#schemeRules(scheme);
		if (!writers.includes(writer)) {
			throw new PermissionError(scheme, writer, writers);
		}
		const scope = this.#resolveScope(kind, runId, projectId);
		// Log entries self-describe via `action` so consumers (renderer,
		// client UIs, tests) can read the action without parsing the
		// path. Only inject `action` when the caller passes attributes
		// — a null `attributes` means "don't touch existing" and the
		// SQL's COALESCE handles preservation on UPDATE. If we generated
		// `{action: m[1]}` for every null-attributes log write, every
		// body-only update to a log entry would clobber existing attrs
		// (command, summary, demotedCount, ...).
		const effectiveAttributes = attributes ? { ...attributes } : null;
		if (scheme === "log" && effectiveAttributes) {
			const m = normalized.match(/^log:\/\/turn_\d+\/([^/]+)\//);
			if (m) effectiveAttributes.action = m[1];
		}
		const entry = await this.#db.upsert_entry.get({
			scope,
			path: normalized,
			body,
			attributes: effectiveAttributes
				? JSON.stringify(effectiveAttributes)
				: null,
			hash,
		});
		const effectiveState = state === undefined ? "resolved" : state;
		const effectiveVisibility =
			visibility === undefined
				? this.#defaultVisibility(scheme, category)
				: visibility;
		await this.#db.upsert_run_view.run({
			run_id: runId,
			entry_id: entry.id,
			loop_id: loopId,
			turn,
			state: effectiveState,
			outcome,
			visibility: effectiveVisibility,
		});
		this.#emitChanged(runId, normalized, "upsert");
		if (effectiveState !== "proposed") {
			this.#drainPendingResolution(runId, normalized);
		}
	}

	/**
	 * get — promote entry(ies) to visible visibility. Default visibility is
	 * "visible"; pass visibility explicitly for a read-with-side-effect at
	 * a different visibility (rare).
	 */
	async get({
		runId,
		turn = 0,
		path,
		bodyFilter = null,
		visibility = "visible",
	}) {
		if (!runId) throw new Error("get: runId is required");
		if (!path) throw new Error("get: path is required");
		if (visibility === "visible") {
			await this.#db.promote_by_pattern.run({
				run_id: runId,
				path,
				body: bodyFilter,
				turn,
			});
		} else {
			await this.#db.demote_by_pattern.run({
				run_id: runId,
				path,
				body: bodyFilter,
			});
		}
		this.#emitChanged(runId, path, "promote");
	}

	/**
	 * rm — remove entry view(s). Matches single path or pattern; optional
	 * bodyFilter narrows pattern matches. `filesOnly` restricts to bare
	 * file-scheme entries (scheme IS NULL).
	 */
	async rm({ runId, path, bodyFilter = null, filesOnly = false }) {
		if (!runId) throw new Error("rm: runId is required");
		if (!path) throw new Error("rm: path is required");
		if (filesOnly) {
			await this.#db.delete_file_entries_by_pattern.run({
				run_id: runId,
				pattern: path,
			});
		} else if (bodyFilter !== null || /[*?[\]]/.test(path)) {
			await this.#db.delete_entries_by_pattern.run({
				run_id: runId,
				path,
				body: bodyFilter,
			});
		} else {
			const normalized = Entries.normalizePath(path);
			await this.#db.delete_known_entry.run({
				run_id: runId,
				path: normalized,
			});
		}
		this.#emitChanged(runId, path, "remove");
	}

	/**
	 * cp — copy an entry to a new path. Source body becomes new body;
	 * source view unchanged.
	 */
	async cp({
		runId,
		turn = 0,
		from,
		to,
		visibility,
		attributes,
		loopId,
		writer,
	}) {
		if (!runId) throw new Error("cp: runId is required");
		if (!from || !to) throw new Error("cp: from and to are required");
		const sourceBody = await this.getBody(runId, from);
		if (sourceBody === null) return;
		await this.set({
			runId,
			turn,
			path: to,
			body: sourceBody,
			visibility,
			attributes,
			loopId,
			writer,
		});
	}

	/**
	 * mv — rename an entry. Equivalent to cp + rm on source.
	 */
	async mv({
		runId,
		turn = 0,
		from,
		to,
		visibility,
		attributes,
		loopId,
		writer,
	}) {
		if (!runId) throw new Error("mv: runId is required");
		if (!from || !to) throw new Error("mv: from and to are required");
		await this.cp({
			runId,
			turn,
			from,
			to,
			visibility,
			attributes,
			loopId,
			writer,
		});
		await this.rm({ runId, path: from });
	}

	/**
	 * update — once-per-turn lifecycle signal from the model (or plugin
	 * speaking on its behalf). Writes to update://<slug> with body as the
	 * content and attributes.status carrying the model's continuation code
	 * (102 continue, 200/204 terminal, 422 can't-answer). Returns the
	 * slug path.
	 */
	async update({
		runId,
		turn = 0,
		body,
		status = 102,
		attributes = {},
		loopId = null,
		writer = "plugin",
	}) {
		if (!runId) throw new Error("update: runId is required");
		if (body == null) throw new Error("update: body is required");
		const path = await this.logPath(runId, turn, "update", body);
		await this.set({
			runId,
			turn,
			path,
			body,
			state: "resolved",
			loopId,
			writer,
			attributes: { status, ...attributes },
		});
		return path;
	}

	async getEntriesByPattern(
		runId,
		path,
		body = null,
		{ limit = null, offset = null, includeAuditSchemes = false } = {},
	) {
		return this.#db.get_entries_by_pattern.all({
			run_id: runId,
			path,
			body: body ? body : null,
			limit,
			offset,
			include_audit_schemes: includeAuditSchemes ? 1 : null,
		});
	}

	#drainPendingResolution(runId, normalized) {
		const key = `${runId}:${normalized}`;
		const resolver = this.#pendingResolutions.get(key);
		if (resolver) {
			this.#pendingResolutions.delete(key);
			resolver();
		}
	}

	async waitForResolution(runId, path) {
		// Check current state first — if a synchronous in-process resolver
		// (yolo) flipped the entry to terminal during proposal.pending,
		// the state change has already happened and no future drain will
		// fire. Without this guard, in-process resolvers would deadlock.
		const current = await this.getState(runId, path);
		if (current && current.state !== "proposed" && current.state !== "streaming") {
			return;
		}
		const normalized = Entries.normalizePath(path);
		const key = `${runId}:${normalized}`;
		return new Promise((resolve) => {
			this.#pendingResolutions.set(key, resolve);
		});
	}

	async getLog(runId) {
		return this.#db.get_results.all({ run_id: runId });
	}

	async getEntries(runId) {
		return this.#db.get_known_entries.all({ run_id: runId });
	}

	async getFileEntries(runId) {
		return this.#db.get_file_entries.all({ run_id: runId });
	}

	async getFileStatesByPattern(runId, pattern) {
		return this.#db.get_file_states_by_pattern.all({ run_id: runId, pattern });
	}

	async hasRejections(runId, loopId) {
		const row = await this.#db.has_rejections.get({
			run_id: runId,
			loop_id: loopId,
		});
		return row.count > 0;
	}

	async hasAcceptedActions(runId) {
		const row = await this.#db.has_accepted_actions.get({ run_id: runId });
		return row.count > 0;
	}

	async getUnresolved(runId) {
		return this.#db.get_unresolved.all({ run_id: runId });
	}

	async countUnknowns(runId) {
		const row = await this.#db.count_unknowns.get({ run_id: runId });
		return row.count;
	}

	async getUnknownValues(runId) {
		const rows = await this.#db.get_unknown_values.all({ run_id: runId });
		return new Set(rows.map((r) => r.body));
	}

	/**
	 * Unknown entries for a run, in DB order. Rows include path + body.
	 */
	async getUnknowns(runId) {
		return this.#db.get_unknowns.all({ run_id: runId });
	}

	async forkEntries(parentRunId, childRunId) {
		await this.#db.fork_known_entries.run({
			new_run_id: childRunId,
			parent_run_id: parentRunId,
		});
	}

	async archivePriorPromptArtifacts(runId, currentTurn) {
		await this.#db.archive_prior_prompt_artifacts.run({
			run_id: runId,
			current_turn: currentTurn,
		});
	}

	/**
	 * Demote all promoted entries for a run on a given turn. Returns the
	 * affected rows (path, tokens) so callers can summarize.
	 *
	 * Implemented as SELECT-then-UPDATE because SQLite's RETURNING doesn't
	 * support the cross-table lookup needed to report content paths/tokens
	 * from the view-layer update.
	 */
	async demoteTurnEntries(runId, turn) {
		const targets = await this.#db.get_turn_demotion_targets.all({
			run_id: runId,
			turn,
		});
		await this.#db.demote_turn_entries.run({ run_id: runId, turn });
		return targets;
	}

	/**
	 * Demote every currently-visible entry in a run. Used by budget
	 * postDispatch as the fallback when this-turn demotion finds nothing
	 * and the packet still overflows — left-over promotions from prior
	 * turns the model didn't demote themselves. Returns the affected
	 * rows (path, tokens, turn) ordered oldest promotion first so the
	 * error body can name them.
	 */
	async demoteRunVisibleEntries(runId) {
		const targets = await this.#db.get_run_visible_targets.all({
			run_id: runId,
		});
		await this.#db.demote_run_visible.run({ run_id: runId });
		return targets;
	}

	/**
	 * Run metadata lookup. Exposed here so plugins don't reach into
	 * core.db for run-scoped lookups.
	 */
	async getRun(runId) {
		return this.#db.get_run_by_id.get({ id: runId });
	}

	/**
	 * Turn-level usage stats write (telemetry). Same rationale as getRun.
	 */
	async updateTurnStats(stats) {
		return this.#db.update_turn_stats.run(stats);
	}

	async getBody(runId, path) {
		const row = await this.#db.get_entry_body.get({
			run_id: runId,
			path: Entries.normalizePath(path),
		});
		if (!row) return null;
		return row.body;
	}

	async setAttributes(runId, path, attrs) {
		const normalized = Entries.normalizePath(path);
		await this.#db.update_entry_attributes.run({
			run_id: runId,
			path: normalized,
			attributes: JSON.stringify(attrs),
		});
		this.#emitChanged(runId, normalized, "attributes");
	}

	async getState(runId, path) {
		return this.#db.get_entry_state.get({
			run_id: runId,
			path: Entries.normalizePath(path),
		});
	}

	async getAttributes(runId, path) {
		const row = await this.#db.get_entry_attributes.get({
			run_id: runId,
			path: Entries.normalizePath(path),
		});
		return row?.attributes ? JSON.parse(row.attributes) : null;
	}

	async getTurnAudit(runId, turn) {
		return this.#db.get_turn_audit.all({ run_id: runId, turn });
	}

	static toolFromPath(path) {
		return Entries.scheme(path);
	}

	static isSystemPath(path) {
		return path.includes("://");
	}
}
