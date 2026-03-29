export default class KnownStore {
	#db;

	constructor(db) {
		this.#db = db;
	}

	static domain(key) {
		if (key.startsWith("/:known/") || key.startsWith("/:unknown/")) return "known";
		if (key.startsWith("/:")) return "result";
		return "file";
	}

	async nextTurn(runId) {
		const row = await this.#db.next_turn.get({ run_id: runId });
		return row.turn;
	}

	async nextResultKey(runId, toolName) {
		const row = await this.#db.next_result_key.get({ run_id: runId });
		return `/:${toolName}/${row.seq}`;
	}

	async upsert(runId, turn, key, value, state, { meta = null, hash = null } = {}) {
		const domain = KnownStore.domain(key);
		await this.#db.upsert_known_entry.run({
			run_id: runId,
			turn,
			key,
			value,
			domain,
			state,
			hash,
			meta: meta ? JSON.stringify(meta) : null,
		});
	}

	async promote(runId, key, turn) {
		await this.#db.promote_key.run({ run_id: runId, key, turn });
	}

	async demote(runId, key) {
		await this.#db.demote_key.run({ run_id: runId, key });
	}

	async remove(runId, key) {
		await this.#db.delete_known_entry.run({ run_id: runId, key });
	}

	async resolve(runId, key, state, value) {
		await this.#db.resolve_known_entry.run({ run_id: runId, key, state, value });
	}

	/**
	 * Build the ordered model context array.
	 * Each bucket is a separate SQL query. No full-table scan.
	 *
	 * Order:
	 *   1. Active known (/:known/* at turn > 0)
	 *   2. Stored known (/:known/* at turn 0)
	 *   3. Stored file paths (turn 0, not symbols, not ignore)
	 *   4. Symbol files
	 *   5. Full files (turn > 0, not ignore)
	 *   6. Chronological results (not proposed)
	 *   7. Unknowns (/:unknown/*)
	 *   8. Latest user prompt
	 */
	async getModelContext(runId) {
		const context = [];

		// 1. Active known
		for (const r of await this.#db.get_active_known.all({ run_id: runId })) {
			context.push({ key: r.key, state: "full", value: r.value });
		}

		// 2. Stored known
		for (const r of await this.#db.get_stored_known.all({ run_id: runId })) {
			context.push({ key: r.key, state: "stored", value: "" });
		}

		// 3. Stored file paths
		for (const r of await this.#db.get_stored_files.all({ run_id: runId })) {
			context.push({ key: r.key, state: "file:path", value: "" });
		}

		// 4. Symbol files
		for (const r of await this.#db.get_symbol_files.all({ run_id: runId })) {
			const meta = r.meta ? JSON.parse(r.meta) : null;
			context.push({ key: r.key, state: "file:symbols", value: meta?.symbols || r.value || "" });
		}

		// 5. Full files
		for (const r of await this.#db.get_full_files.all({ run_id: runId })) {
			const fileState = r.state === "readonly" ? "file:readonly"
				: r.state === "active" ? "file:active"
				: "file";
			context.push({ key: r.key, state: fileState, value: r.value });
		}

		// 6. Chronological results
		for (const r of await this.#db.get_results.all({ run_id: runId })) {
			const tool = KnownStore.toolFromKey(r.key);
			const meta = r.meta ? JSON.parse(r.meta) : {};
			context.push({
				key: r.key,
				state: r.state,
				value: r.state === "summary" ? r.value : "",
				tool: tool || r.state,
				target: meta.command || meta.file || meta.key || meta.question || "",
			});
		}

		// 7. Unknowns
		for (const r of await this.#db.get_unknowns.all({ run_id: runId })) {
			context.push({ key: r.key, state: "unknown", value: r.value });
		}

		// 8. Latest prompt
		const prompt = await this.#db.get_latest_prompt.get({ run_id: runId });
		if (prompt) {
			context.push({ key: prompt.key, state: "prompt", value: prompt.value });
		}

		return context;
	}

	/**
	 * Get the chronological log (result-domain entries).
	 */
	async getLog(runId) {
		const rows = await this.#db.get_results.all({ run_id: runId });
		return rows.map((row) => {
			const tool = KnownStore.toolFromKey(row.key);
			const meta = row.meta ? JSON.parse(row.meta) : {};
			return {
				tool: tool || row.status,
				target: meta.command || meta.file || meta.key || meta.question || "",
				status: row.state,
				key: row.key,
				value: row.state === "summary" ? row.value : "",
			};
		});
	}

	async getFileEntries(runId) {
		return this.#db.get_file_entries.all({ run_id: runId });
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

	static toolFromKey(key) {
		const match = key.match(/^\/:([a-z_]+)\//);
		return match ? match[1] : null;
	}

	static isSystemKey(key) {
		return key.startsWith("/:");
	}
}
