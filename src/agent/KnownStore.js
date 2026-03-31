import { countTokens } from "./tokens.js";

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

	async nextResultPath(runId, toolName) {
		const row = await this.#db.next_result_key.get({ run_id: runId });
		return `${toolName}://${row.seq}`;
	}

	async upsert(
		runId,
		turn,
		path,
		value,
		state,
		{ meta = null, hash = null, updatedAt = null } = {},
	) {
		const scheme = KnownStore.scheme(path);
		await this.#db.upsert_known_entry.run({
			run_id: runId,
			turn,
			path,
			value,
			scheme,
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
	 * Build the ordered model context array.
	 * Each bucket is a separate SQL query. No full-table scan.
	 *
	 * Order:
	 *   1. Active known (known://* at turn > 0)
	 *   2. Stored known (known://* at turn 0)
	 *   3. Stored file paths (turn 0, not symbols, not ignore)
	 *   4. Symbol files
	 *   5. Full files (turn > 0, not ignore)
	 *   6. Chronological results (not proposed)
	 *   7. Unknowns (unknown://*)
	 *   8. Latest user prompt
	 */
	async getModelContext(runId) {
		const context = [];

		// 1. Active known
		for (const r of await this.#db.get_active_known.all({ run_id: runId })) {
			context.push({ path: r.path, state: "full", value: r.value });
		}

		// 2. Stored known
		for (const r of await this.#db.get_stored_known.all({ run_id: runId })) {
			context.push({ path: r.path, state: "stored", value: "" });
		}

		// 3. Stored file paths
		for (const r of await this.#db.get_stored_files.all({ run_id: runId })) {
			context.push({ path: r.path, state: "file:path", value: "" });
		}

		// 4. Symbol files — value from meta.symbols, never raw file content
		for (const r of await this.#db.get_symbol_files.all({ run_id: runId })) {
			const meta = r.meta ? JSON.parse(r.meta) : null;
			context.push({
				path: r.path,
				state: "file:symbols",
				value: meta?.symbols || "",
			});
		}

		// 5. Full files
		for (const r of await this.#db.get_full_files.all({ run_id: runId })) {
			const fileState =
				r.state === "readonly"
					? "file:readonly"
					: r.state === "active"
						? "file:active"
						: "file";
			context.push({
				path: r.path,
				state: fileState,
				value: r.value,
				tokens: r.tokens,
			});
		}

		// 6. Chronological results — filtered by tool type
		for (const r of await this.#db.get_results.all({ run_id: runId })) {
			const tool = KnownStore.toolFromPath(r.path);
			const meta = r.meta ? JSON.parse(r.meta) : {};
			const target = meta.command || meta.path || meta.question || "";

			let value = "";
			if (r.state === "summary") value = r.value;
			else if (tool === "env" || tool === "run" || tool === "ask_user")
				value = r.value;
			else if (tool === "edit" && meta.blocks?.length > 0)
				value = meta.blocks
					.map((b) =>
						b.search === null
							? `+++ ${b.replace?.slice(0, 200)}`
							: `--- ${b.search?.slice(0, 100)}\n+++ ${b.replace?.slice(0, 200)}`,
					)
					.join("\n");

			context.push({
				path: r.path,
				state: r.state,
				value,
				tool: tool || r.state,
				target,
			});
		}

		// 7. Unknowns
		for (const r of await this.#db.get_unknowns.all({ run_id: runId })) {
			context.push({ path: r.path, state: "unknown", value: r.value });
		}

		// 8. Latest prompt
		const prompt = await this.#db.get_latest_prompt.get({ run_id: runId });
		if (prompt) {
			context.push({
				path: prompt.path,
				state: "prompt",
				value: prompt.value,
			});
		}

		return context;
	}

	/**
	 * Get the chronological log (result-domain entries).
	 */
	async getLog(runId) {
		const rows = await this.#db.get_results.all({ run_id: runId });
		return rows.map((row) => {
			const tool = KnownStore.toolFromPath(row.path);
			const meta = row.meta ? JSON.parse(row.meta) : {};
			const target = meta.command || meta.path || meta.question || "";

			let value = "";
			if (row.state === "summary") value = row.value;
			else if (tool === "env" || tool === "run" || tool === "ask_user")
				value = row.value;

			return {
				tool: tool || row.state,
				target,
				status: row.state,
				path: row.path,
				value,
			};
		});
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

	/**
	 * Token distribution across context buckets.
	 * Returns: [{ bucket, tokens, entries }]
	 */
	async getContextDistribution(runId) {
		return this.#db.get_context_distribution.all({ run_id: runId });
	}

	/**
	 * Recount tokens for all entries written on a specific turn.
	 * Bulk read → batch encode → bulk write. Encoder stays warm.
	 * Call async after the turn completes — not on the hot path.
	 */
	async recountTokens(runId, turn) {
		const rows = await this.#db.get_stale_tokens.all({ run_id: runId, turn });
		if (rows.length === 0) return;

		const updates = rows.map((row) => ({
			path: row.path,
			tokens: countTokens(row.value),
		}));

		for (const { path, tokens } of updates) {
			await this.#db.recount_tokens.run({ run_id: runId, path, tokens });
		}
	}

	static toolFromPath(path) {
		return KnownStore.scheme(path);
	}

	static isSystemPath(path) {
		return path.includes("://");
	}
}
