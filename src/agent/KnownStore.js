import slugify from "../sql/functions/slugify.js";

export default class KnownStore {
	#db;

	constructor(db) {
		this.#db = db;
	}

	static scheme(path) {
		const idx = path.indexOf("://");
		return idx > 0 ? path.slice(0, idx) : null;
	}

	async nextTurn(runId) {
		const row = await this.#db.next_turn.get({ run_id: runId });
		return row.turn;
	}

	async slugPath(runId, scheme, content) {
		const base = slugify(content || "");
		const prefix = `${scheme}://`;

		if (!base) {
			const row = await this.#db.next_result_key.get({ run_id: runId });
			return `${prefix}${row.seq}`;
		}

		const candidate = `${prefix}${base}`;
		const existing = await this.#db.get_entry_value.get({
			run_id: runId,
			path: candidate,
		});
		if (!existing) return candidate;

		// Collision — find next available integer suffix
		let n = 2;
		while (true) {
			const suffixed = `${prefix}${base}${n}`;
			const row = await this.#db.get_entry_value.get({
				run_id: runId,
				path: suffixed,
			});
			if (!row) return suffixed;
			n++;
		}
	}

	async upsert(
		runId,
		turn,
		path,
		value,
		state,
		{ meta = null, hash = null, updatedAt = null } = {},
	) {
		await this.#db.upsert_known_entry.run({
			run_id: runId,
			turn,
			path,
			value,
			state,
			hash,
			meta: meta ? JSON.stringify(meta) : null,
			updated_at: updatedAt,
		});
	}

	async promote(runId, path, turn) {
		await this.#db.promote_path.run({ run_id: runId, path, turn });
	}

	async setFileState(runId, pattern, state) {
		const result = await this.#db.set_file_state.run({
			run_id: runId,
			pattern,
			state,
		});
		if (result.changes === 0) {
			await this.upsert(runId, 0, pattern, "", state);
		}
	}

	async demote(runId, path) {
		await this.#db.demote_path.run({ run_id: runId, path });
	}

	async remove(runId, path) {
		await this.#db.delete_known_entry.run({ run_id: runId, path });
	}

	async removeFilesByPattern(runId, pattern) {
		await this.#db.delete_file_entries_by_pattern.run({
			run_id: runId,
			pattern,
		});
	}

	static #valuePattern(value) {
		if (!value) return null;
		if (/[*+?^${}()|[\]\\]/.test(value)) return value;
		return `*${value}*`;
	}

	async promoteByPattern(runId, path, value, turn) {
		await this.#db.promote_by_pattern.run({
			run_id: runId,
			path,
			value: KnownStore.#valuePattern(value),
			turn,
		});
	}

	async demoteByPattern(runId, path, value) {
		await this.#db.demote_by_pattern.run({
			run_id: runId,
			path,
			value: KnownStore.#valuePattern(value),
		});
	}

	async getEntriesByPattern(runId, path, value) {
		return this.#db.get_entries_by_pattern.all({
			run_id: runId,
			path,
			value: KnownStore.#valuePattern(value),
		});
	}

	async deleteByPattern(runId, path, value) {
		await this.#db.delete_entries_by_pattern.run({
			run_id: runId,
			path,
			value: KnownStore.#valuePattern(value),
		});
	}

	async updateValueByPattern(runId, path, value, newValue) {
		await this.#db.update_value_by_pattern.run({
			run_id: runId,
			path,
			value: KnownStore.#valuePattern(value),
			new_value: newValue,
		});
	}

	async resolve(runId, path, state, value) {
		await this.#db.resolve_known_entry.run({
			run_id: runId,
			path,
			state,
			value,
		});
	}

	/**
	 * Get the chronological log (result-domain entries).
	 */
	async getLog(runId) {
		return this.#db.get_results.all({ run_id: runId });
	}

	async getFileEntries(runId) {
		return this.#db.get_file_entries.all({ run_id: runId });
	}

	async getFileStatesByPattern(runId, pattern) {
		return this.#db.get_file_states_by_pattern.all({ run_id: runId, pattern });
	}

	async hasRejections(runId) {
		const row = await this.#db.has_rejections.get({ run_id: runId });
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
		return new Set(rows.map((r) => r.value));
	}

	async getValue(runId, path) {
		const row = await this.#db.get_entry_value.get({ run_id: runId, path });
		return row?.value ?? null;
	}

	async getMeta(runId, path) {
		const row = await this.#db.get_entry_meta.get({ run_id: runId, path });
		return row?.meta ? JSON.parse(row.meta) : null;
	}

	/**
	 * Get all entries written on a specific turn (audit/debug).
	 */
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
