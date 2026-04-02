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

		if (!base) return `${prefix}${Date.now()}`;

		const candidate = `${prefix}${base}`;
		const existing = await this.#db.get_entry_body.get({
			run_id: runId,
			path: candidate,
		});
		if (!existing) return candidate;

		return `${prefix}${base}_${Date.now()}`;
	}

	async upsert(
		runId,
		turn,
		path,
		body,
		state,
		{ attributes = null, hash = null, updatedAt = null } = {},
	) {
		await this.#db.upsert_known_entry.run({
			run_id: runId,
			turn,
			path,
			body,
			state,
			hash,
			attributes: attributes ? JSON.stringify(attributes) : null,
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

	static #bodyPattern(body) {
		if (!body) return null;
		if (/[*+?^${}()|[\]\\]/.test(body)) return body;
		return `*${body}*`;
	}

	async promoteByPattern(runId, path, body, turn) {
		await this.#db.promote_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
			turn,
		});
	}

	async demoteByPattern(runId, path, body) {
		await this.#db.demote_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
		});
	}

	async getEntriesByPattern(runId, path, body) {
		return this.#db.get_entries_by_pattern.all({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
		});
	}

	async deleteByPattern(runId, path, body) {
		await this.#db.delete_entries_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
		});
	}

	async updateBodyByPattern(runId, path, body, newBody) {
		await this.#db.update_body_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
			new_body: newBody,
		});
	}

	async resolve(runId, path, state, body) {
		await this.#db.resolve_known_entry.run({
			run_id: runId,
			path,
			state,
			body,
		});
	}

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
		return new Set(rows.map((r) => r.body));
	}

	async getBody(runId, path) {
		const row = await this.#db.get_entry_body.get({ run_id: runId, path });
		return row?.body ?? null;
	}

	async getAttributes(runId, path) {
		const row = await this.#db.get_entry_attributes.get({ run_id: runId, path });
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
