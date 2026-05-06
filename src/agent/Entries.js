import slugify from "../sql/functions/slugify.js";
import { EntryOverflowError, PermissionError } from "./errors.js";
import encodeSegment from "./pathEncode.js";

// SQLite surfaces the CHECK as either err.code === "SQLITE_CONSTRAINT_CHECK"
// or an Error whose message names the failing column. Both forms appear in
// the wild depending on the driver build, so we match defensively.
// Caller-side contract: only invoked from a SQL try/catch, so err is always
// an Error instance — err.message is a string (possibly empty), not undefined.
function isBodyOverflow(err) {
	if (!err) return false;
	if (err.code === "SQLITE_CONSTRAINT_CHECK") return true;
	return err.message.includes("CHECK") && err.message.includes("length(body)");
}

function translateBodyOverflow(err, path, body) {
	if (!isBodyOverflow(err)) return err;
	const size = body == null ? 0 : body.length;
	return new EntryOverflowError(path, size);
}

// Already-an-error path: log://turn_N/error/<slug>. The auto-failure
// hook below skips these to break the recursion (error.log.emit's
// handler ALSO writes state=failed when materializing its own entry).
const ERROR_PATH_RE = /^log:\/\/turn_\d+\/error\//;

// Streaming data channels for env/sh actions (env://turn_N/cmd_K,
// sh://turn_N/cmd_K). Their failure is already captured by the parent
// log://turn_N/<scheme>/<slug> action entry's auto-emit; emitting again
// for each channel produces redundant duplicates with empty-body
// fallback messages.
const CHANNEL_PATH_RE = /^(env|sh):\/\/turn_\d+\//;

export default class Entries {
	#db;
	#onChanged;
	#onError;
	#onFailed;
	#schemes = new Map();
	#schemesLoaded = null;
	#seq = 0;
	#pendingResolutions = new Map();

	// onError is the centralized site for storage-layer rejections that
	// should surface to the model as strikes rather than crash the run.
	// Today: EntryOverflowError (RUMMY_ENTRY_SIZE_MAX CHECK violations).
	// When onError is supplied, set() catches the typed error, dispatches
	// it to the callback (which emits hooks.error.log → 413 strike), and
	// returns silently — callers don't need to handle storage-layer
	// rejections at every write site. When onError is null (e.g. unit
	// tests with a bare Entries), the error propagates as before.
	//
	// onFailed is the universal failure-rendering enforcer: every
	// transition to state="failed" on a non-error path fires this
	// callback so a SEPARATE log://turn_N/error/<slug> entry is created
	// alongside the action entry. Without this, plugins that record
	// failure via entries.set({state: "failed", ...}) leave nothing for
	// the model to recognize as an error — failure encodes only as tiny
	// JSON metadata indistinguishable from a successful entry. The
	// callback wires to hooks.error.log.emit (see ProjectAgent).
	constructor(db, { onChanged = null, onError = null, onFailed = null } = {}) {
		this.#db = db;
		this.#onChanged = onChanged;
		this.#onError = onError;
		this.#onFailed = onFailed;
	}

	// Populate the scheme cache; idempotent, lazy on first need.
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
			return `${scheme}://${decoded.split("/").map(encodeSegment).join("/")}`;
		} catch {
			return `${scheme}://${rest.split("/").map(encodeSegment).join("/")}`;
		}
	}

	async nextTurn(runId) {
		const row = await this.#db.next_turn.get({ run_id: runId });
		return row.turn;
	}

	async dedup(runId, scheme, target, turn) {
		const encodedTarget = encodeSegment(target);
		const turnPrefix = turn ? `turn_${turn}/` : "";
		const candidate = `${scheme}://${turnPrefix}${encodedTarget}`;
		const existing = await this.#db.get_entry_body.get({
			run_id: runId,
			path: candidate,
		});
		if (!existing) return candidate;
		return `${candidate}_${++this.#seq}`;
	}

	// Single namespace log://turn_N/action/slug. slug is built via slugify
	// (80-char cap + integer tie-breaker on collision) — same contract as
	// slugPath. Plugins (including externals) can trust that any target
	// they pass will produce a bounded, unique log path, regardless of
	// the target's length or character composition. Full payload always
	// belongs in the entry body, not the slug.
	async logPath(runId, turn, action, target) {
		const slug = target == null ? "" : slugify(String(target));
		const base = slug
			? `log://turn_${turn}/${action}/${slug}`
			: `log://turn_${turn}/${action}/_`;
		const existing = await this.#db.get_entry_body.get({
			run_id: runId,
			path: base,
		});
		if (!existing) return base;
		return `${base}_${++this.#seq}`;
	}

	async slugPath(runId, scheme, content, tags) {
		// tags > content > empty; slugify("") yields "" and we sequence-only.
		let source = "";
		if (tags) source = tags;
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

	// Scheme's scope/writers/category; bare paths default to run + model/plugin.
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

	// set — create or update an entry; see PLUGINS.md primitives.
	async set(args) {
		if (!args.runId) throw new Error("set: runId is required");
		if (!args.path) throw new Error("set: path is required");
		try {
			return await this.#setImpl(args);
		} catch (err) {
			// EntryOverflowError: storage-layer CHECK fired. When the host
			// supplies onError (the production wiring), route the strike
			// to error.log and return silently — every set() caller in
			// the codebase becomes overflow-safe without per-site catches.
			// Without onError (raw unit tests), propagate as before.
			if (err instanceof EntryOverflowError && this.#onError) {
				// Destructure with the same defaults as #setImpl so the
				// callback sees the same loopId/turn shape callers wrote
				// against — no `??` fallback shim, just contract alignment.
				const { runId, loopId = null, turn = 0 } = args;
				await this.#onError({
					runId,
					loopId,
					turn,
					error: err,
				});
				return;
			}
			throw err;
		}
	}

	async #setImpl({
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
		// Pattern mode is explicit; never inferred from `*` in path.
		const isPattern = pattern === true || bodyFilter !== null;

		if (isPattern) {
			if (body != null && !append) {
				try {
					await this.#db.update_body_by_pattern.run({
						run_id: runId,
						path,
						body: bodyFilter,
						new_body: body,
					});
				} catch (err) {
					throw translateBodyOverflow(err, path, body);
				}
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
			try {
				await this.#db.append_entry_body.run({
					run_id: runId,
					path: normalized,
					chunk: body,
				});
			} catch (err) {
				throw translateBodyOverflow(err, normalized, body);
			}
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
				if (state === "failed") {
					await this.#fireFailed({
						runId,
						turn,
						loopId,
						path: normalized,
						outcome,
					});
				}
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
		// Inject `action` only when caller passes attributes; null means COALESCE preserves existing.
		const effectiveAttributes = attributes ? { ...attributes } : null;
		if (scheme === "log" && effectiveAttributes) {
			const m = normalized.match(/^log:\/\/turn_\d+\/([^/]+)\//);
			if (m) effectiveAttributes.action = m[1];
		}
		let entry;
		try {
			entry = await this.#db.upsert_entry.get({
				scope,
				path: normalized,
				body,
				attributes: effectiveAttributes
					? JSON.stringify(effectiveAttributes)
					: null,
				hash,
			});
		} catch (err) {
			throw translateBodyOverflow(err, normalized, body);
		}
		const effectiveState = state === undefined ? "resolved" : state;
		// Visibility resolution: explicit > preserve-existing > scheme-default.
		// A body update without visibility= must NOT silently reset visibility
		// to the scheme default — that would hide content the model just
		// promoted (e.g. a model <get>'d file then <set> SEARCH/REPLACE
		// would lose its visible status). Preserve what's there.
		let effectiveVisibility;
		if (visibility !== undefined) {
			effectiveVisibility = visibility;
		} else {
			const existing = await this.getState(runId, normalized);
			if (existing?.visibility) {
				effectiveVisibility = existing.visibility;
			} else {
				effectiveVisibility = this.#defaultVisibility(scheme, category);
			}
		}
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
		if (effectiveState === "failed") {
			await this.#fireFailed({
				runId,
				turn,
				loopId,
				path: normalized,
				body,
				outcome,
			});
		}
	}

	// Fire onFailed for any state→failed transition on a non-error path.
	// The auto-emit creates a sibling log://turn_N/error/<slug> entry so
	// the failure appears in the model's <log> as a category-distinct
	// item, not just metadata buried in the action's own log entry.
	async #fireFailed({ runId, turn, loopId, path, body, outcome }) {
		if (!this.#onFailed) return;
		if (ERROR_PATH_RE.test(path)) return;
		if (CHANNEL_PATH_RE.test(path)) return;
		// Body-less state changes don't carry a message; fall back to the
		// outcome string (or the path itself) so the error entry has a
		// recognizable slug instead of an empty one.
		let message = body;
		if (!message) {
			if (outcome) message = `failed: ${outcome}`;
			else message = `failed: ${path}`;
		}
		await this.#onFailed({
			runId,
			turn,
			loopId,
			sourcePath: path,
			body: message,
			outcome,
		});
	}

	// get — promote entry(ies); see PLUGINS.md primitives.
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

	// rm — remove entry view(s); see PLUGINS.md primitives.
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

	// cp — copy an entry to a new path; see PLUGINS.md primitives.
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

	// mv — rename (cp + rm).
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

	// update — once-per-turn lifecycle signal; see PLUGINS.md.
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
		{
			limit = null,
			offset = null,
			since = null,
			includeAuditSchemes = false,
		} = {},
	) {
		return this.#db.get_entries_by_pattern.all({
			run_id: runId,
			path,
			body: body ? body : null,
			limit,
			offset,
			since,
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
		// Pre-check: yolo's synchronous resolver may have already flipped state, no drain will fire.
		const current = await this.getState(runId, path);
		if (
			current &&
			current.state !== "proposed" &&
			current.state !== "streaming"
		) {
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

	// Unknown entries in DB order; rows include path + body.
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

	// SELECT-then-UPDATE: SQLite RETURNING can't cross to the view layer.
	async demoteTurnEntries(runId, turn) {
		const targets = await this.#db.get_turn_demotion_targets.all({
			run_id: runId,
			turn,
		});
		await this.#db.demote_turn_entries.run({ run_id: runId, turn });
		return targets;
	}

	// Budget postDispatch fallback: demote every visible entry in the run.
	async demoteRunVisibleEntries(runId) {
		const targets = await this.#db.get_run_visible_targets.all({
			run_id: runId,
		});
		await this.#db.demote_run_visible.run({ run_id: runId });
		return targets;
	}

	// Plugin-facing run lookup; avoids reaching into core.db.
	async getRun(runId) {
		return this.#db.get_run_by_id.get({ id: runId });
	}

	// Plugin-facing turn-stats write.
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
