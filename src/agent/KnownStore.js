import slugify from "../sql/functions/slugify.js";

export default class KnownStore {
	#db;
	#onChanged;
	#schemes = new Map();
	#schemesLoaded = null;
	#seq = 0;
	#pendingResolutions = new Map();

	constructor(db, { onChanged } = {}) {
		this.#db = db;
		this.#onChanged = onChanged || null;
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

	async slugPath(runId, scheme, content, summary) {
		const source = summary || content || "";
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
	 * Resolve a scheme's declared scope kind + writer list. Falls back to
	 * generous defaults (run + model/plugin) if the scheme isn't loaded
	 * or lacks declarations — preserves V1 behavior for legacy paths.
	 */
	async #schemeRules(scheme) {
		await this.#ensureSchemes();
		const row = scheme ? this.#schemes.get(scheme) : null;
		const kind = row?.default_scope || "run";
		let writers = ["model", "plugin"];
		if (row?.writable_by) {
			try {
				const parsed =
					typeof row.writable_by === "string"
						? JSON.parse(row.writable_by)
						: row.writable_by;
				if (Array.isArray(parsed)) writers = parsed;
			} catch {}
		}
		return { kind, writers };
	}

	#resolveScope(kind, runId) {
		if (kind === "global") return "global";
		if (kind === "project") {
			// Phase D doesn't plumb projectId into the Repository yet; project-
			// scoped schemes need a follow-up to pass it through. Falling back
			// to run-scope keeps behavior sane until then.
			return `run:${runId}`;
		}
		return `run:${runId}`;
	}

	async upsert(
		runId,
		turn,
		path,
		body,
		state = "resolved",
		{
			outcome = null,
			fidelity = "promoted",
			attributes = null,
			hash = null,
			loopId = null,
			writer = "plugin",
		} = {},
	) {
		const normalized = KnownStore.normalizePath(path);
		const scheme = KnownStore.scheme(normalized);
		const { kind, writers } = await this.#schemeRules(scheme);

		if (!writers.includes(writer)) {
			throw new Error(
				`403: writer "${writer}" not permitted for scheme "${scheme ?? "file"}" (allowed: ${writers.join(", ")})`,
			);
		}

		const scope = this.#resolveScope(kind, runId);
		const entry = await this.#db.upsert_entry.get({
			scope,
			path: normalized,
			body,
			attributes: attributes ? JSON.stringify(attributes) : null,
			hash,
		});
		await this.#db.upsert_run_view.run({
			run_id: runId,
			entry_id: entry.id,
			loop_id: loopId,
			turn,
			state,
			outcome,
			fidelity,
		});
		this.#emitChanged(runId, normalized, "upsert");
	}

	async appendBody(runId, path, chunk) {
		const normalized = KnownStore.normalizePath(path);
		await this.#db.append_entry_body.run({
			run_id: runId,
			path: normalized,
			chunk,
		});
		this.#emitChanged(runId, normalized, "append");
	}

	async promote(runId, path, turn) {
		const normalized = KnownStore.normalizePath(path);
		await this.#db.promote_path.run({
			run_id: runId,
			path: normalized,
			turn,
		});
		this.#emitChanged(runId, normalized, "promote");
	}

	async setFileFidelity(runId, pattern, fidelity) {
		const result = await this.#db.set_file_fidelity.run({
			run_id: runId,
			pattern,
			fidelity,
		});
		if (result.changes === 0) {
			await this.upsert(runId, 0, pattern, "", "resolved", { fidelity });
		}
		this.#emitChanged(runId, pattern, "fidelity");
	}

	async setFidelity(runId, path, fidelity) {
		const normalized = KnownStore.normalizePath(path);
		await this.#db.set_fidelity.run({
			run_id: runId,
			path: normalized,
			fidelity,
		});
		this.#emitChanged(runId, normalized, "fidelity");
	}

	async demote(runId, path) {
		const normalized = KnownStore.normalizePath(path);
		await this.#db.demote_path.run({
			run_id: runId,
			path: normalized,
		});
		this.#emitChanged(runId, normalized, "demote");
	}

	async remove(runId, path) {
		const normalized = KnownStore.normalizePath(path);
		await this.#db.delete_known_entry.run({
			run_id: runId,
			path: normalized,
		});
		this.#emitChanged(runId, normalized, "remove");
	}

	async removeFilesByPattern(runId, pattern) {
		await this.#db.delete_file_entries_by_pattern.run({
			run_id: runId,
			pattern,
		});
		this.#emitChanged(runId, pattern, "remove");
	}

	static #bodyPattern(body) {
		return body || null;
	}

	async promoteByPattern(runId, path, body, turn) {
		await this.#db.promote_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
			turn,
		});
		this.#emitChanged(runId, path, "promote");
	}

	async demoteByPattern(runId, path, body) {
		await this.#db.demote_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
		});
		this.#emitChanged(runId, path, "demote");
	}

	async getEntriesByPattern(runId, path, body, { limit, offset } = {}) {
		return this.#db.get_entries_by_pattern.all({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
			limit: limit ?? null,
			offset: offset ?? null,
		});
	}

	async deleteByPattern(runId, path, body) {
		await this.#db.delete_entries_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
		});
		this.#emitChanged(runId, path, "remove");
	}

	async updateBodyByPattern(runId, path, body, newBody) {
		const args = {
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
			new_body: newBody,
		};
		await this.#db.update_body_by_pattern.run(args);
		await this.#db.bump_write_count_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
		});
		this.#emitChanged(runId, path, "body");
	}

	async resolve(runId, path, state, { body = null, outcome = null } = {}) {
		const normalized = KnownStore.normalizePath(path);
		await this.#db.resolve_known_entry_view.run({
			run_id: runId,
			path: normalized,
			state,
			outcome,
		});
		if (body != null) {
			await this.#db.resolve_known_entry_body.run({
				run_id: runId,
				path: normalized,
				body,
			});
		}
		this.#emitChanged(runId, normalized, "resolve");
		const key = `${runId}:${normalized}`;
		const resolver = this.#pendingResolutions.get(key);
		if (resolver) {
			this.#pendingResolutions.delete(key);
			resolver();
		}
	}

	waitForResolution(runId, path) {
		const normalized = KnownStore.normalizePath(path);
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

	/**
	 * Cheap view-only fork in V2. Today: copies all entries. Same signature
	 * so the eventual swap is internal to this method.
	 */
	async forkEntries(parentRunId, childRunId) {
		await this.#db.fork_known_entries.run({
			new_run_id: childRunId,
			parent_run_id: parentRunId,
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
			path: KnownStore.normalizePath(path),
		});
		return row?.body ?? null;
	}

	async setAttributes(runId, path, attrs) {
		const normalized = KnownStore.normalizePath(path);
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
			path: KnownStore.normalizePath(path),
		});
	}

	async getAttributes(runId, path) {
		const row = await this.#db.get_entry_attributes.get({
			run_id: runId,
			path: KnownStore.normalizePath(path),
		});
		return row?.attributes ? JSON.parse(row.attributes) : null;
	}

	async getTurnAudit(runId, turn) {
		return this.#db.get_turn_audit.all({ run_id: runId, turn });
	}

	static toolFromPath(path) {
		return KnownStore.scheme(path);
	}

	static isSystemPath(path) {
		return path.includes("://");
	}
}
