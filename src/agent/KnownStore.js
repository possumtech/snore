import slugify from "../sql/functions/slugify.js";

export default class KnownStore {
	#db;
	#onChanged;
	#schemes = new Map();
	#seq = 0;

	constructor(db, { onChanged } = {}) {
		this.#db = db;
		this.#onChanged = onChanged || null;
	}

	async loadSchemes(db) {
		const rows = await (db || this.#db).get_all_schemes.all();
		this.#schemes.clear();
		for (const row of rows) {
			this.#schemes.set(row.name, row);
		}
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

	async upsert(
		runId,
		turn,
		path,
		body,
		status,
		{
			fidelity = "full",
			attributes = null,
			hash = null,
			updatedAt = null,
			loopId = null,
		} = {},
	) {
		const normalized = KnownStore.normalizePath(path);
		await this.#db.upsert_known_entry.run({
			run_id: runId,
			loop_id: loopId,
			turn,
			path: normalized,
			body,
			status,
			fidelity,
			hash,
			attributes: attributes ? JSON.stringify(attributes) : null,
			updated_at: updatedAt,
		});
		this.#emitChanged(runId, normalized, "upsert");
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
			await this.upsert(runId, 0, pattern, "", 200, { fidelity });
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
		await this.#db.update_body_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
			new_body: newBody,
		});
		this.#emitChanged(runId, path, "body");
	}

	async resolve(runId, path, status, body) {
		const normalized = KnownStore.normalizePath(path);
		await this.#db.resolve_known_entry.run({
			run_id: runId,
			path: normalized,
			status,
			body,
		});
		this.#emitChanged(runId, normalized, "resolve");
	}

	async restoreSummarizedPrompts(runId) {
		await this.#db.restore_summarized_prompts.run({ run_id: runId });
		this.#emitChanged(runId, "prompt://batch", "fidelity");
	}

	async demotePreviousLoopLogging(runId, loopId) {
		await this.#db.demote_previous_loop_logging.run({
			run_id: runId,
			loop_id: loopId,
		});
		this.#emitChanged(runId, "logging://batch", "fidelity");
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
