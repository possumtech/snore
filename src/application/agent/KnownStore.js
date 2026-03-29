export default class KnownStore {
	#db;

	constructor(db) {
		this.#db = db;
	}

	/**
	 * Determine domain from key prefix.
	 */
	static domain(key) {
		if (key.startsWith("/:known/") || key === "/:unknown") return "known";
		if (key.startsWith("/:")) return "result";
		return "file";
	}

	/**
	 * Advance turn counter and return the new turn number.
	 */
	async nextTurn(runId) {
		const row = await this.#db.next_turn.get({ run_id: runId });
		return row.turn;
	}

	/**
	 * Generate the next result key for a tool call.
	 */
	async nextResultKey(runId, toolName) {
		const row = await this.#db.next_result_key.get({ run_id: runId });
		return `/:${toolName}/${row.seq}`;
	}

	/**
	 * UPSERT an entry. Domain is derived from the key.
	 */
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

	/**
	 * Promote a key — set turn to current turn.
	 * read() calls this. The value is already in the store.
	 */
	async promote(runId, key, turn) {
		await this.#db.promote_key.run({ run_id: runId, key, turn });
	}

	/**
	 * Demote a key — set turn to 0 (purgatory).
	 * drop() calls this. Value stays in the store but hidden from model.
	 */
	async demote(runId, key) {
		await this.#db.demote_key.run({ run_id: runId, key });
	}

	/**
	 * Delete an entry by key.
	 */
	async remove(runId, key) {
		await this.#db.delete_known_entry.run({ run_id: runId, key });
	}

	/**
	 * Resolve a proposed entry (change state from proposed to pass/warn/error).
	 */
	async resolve(runId, key, state, value) {
		await this.#db.resolve_known_entry.run({
			run_id: runId,
			key,
			state,
			value,
		});
	}

	/**
	 * Get all entries for a run (raw rows).
	 */
	async getAll(runId) {
		return this.#db.get_known_entries.all({ run_id: runId });
	}

	/**
	 * Get the model-facing known entries.
	 *
	 * Expansion rule:
	 *   turn == currentTurn → expanded (value included)
	 *   turn == 0 → collapsed (key only, no value)
	 *   other → collapsed
	 *
	 * Hidden entries (not shown to model):
	 *   file:ignore, result:proposed, internal keys (/:unknown, /:system/*, etc.)
	 */
	async getModelEntries(runId, currentTurn = 0) {
		const rows = await this.getAll(runId);
		const entries = [];

		for (const row of rows) {
			// Hide internal entries
			if (row.key === "/:unknown") continue;
			if (row.key.startsWith("/:system/")) continue;
			if (row.key.startsWith("/:user/")) continue;
			if (row.key.startsWith("/:reasoning/")) continue;

			// Hide ignored files
			if (row.domain === "file" && row.state === "ignore") continue;

			// Hide proposed results
			if (row.domain === "result" && row.state === "proposed") continue;

			const expanded = row.turn > 0;
			const modelState = KnownStore.#modelState(row.domain, row.state, expanded);

			entries.push({
				key: row.key,
				state: modelState,
				value: expanded ? row.value : "",
			});
		}

		return entries;
	}

	/**
	 * Get the chronological log (summary tool result).
	 */
	async getLog(runId) {
		const rows = await this.#db.get_run_log.all({ run_id: runId });
		return rows.map((row) => {
			const tool = KnownStore.toolFromKey(row.key);
			const meta = row.meta ? JSON.parse(row.meta) : {};
			return {
				tool: tool || row.status,
				target: meta.command || meta.file || meta.key || meta.question || "",
				status: row.status,
				key: row.key,
				value: row.status === "summary" ? row.value : "",
			};
		});
	}

	/**
	 * Get all unresolved (proposed) entries.
	 */
	async getUnresolved(runId) {
		const all = await this.getAll(runId);
		return all.filter((r) => r.domain === "result" && r.state === "proposed");
	}

	/**
	 * Map domain:state + expansion to model-facing state string.
	 */
	static #modelState(domain, state, expanded) {
		if (domain === "file") {
			if (expanded) {
				if (state === "readonly") return "file:readonly";
				if (state === "active") return "file:active";
				return "file";
			}
			return "file:path";
		}
		if (domain === "known") {
			return expanded ? "full" : "stored";
		}
		if (domain === "result") {
			return "stored";
		}
		return "stored";
	}

	/**
	 * Extract tool name from a result key.
	 */
	static toolFromKey(key) {
		const match = key.match(/^\/:([a-z]+)\//);
		return match ? match[1] : null;
	}

	/**
	 * Check if a key is a system key (starts with /:).
	 */
	static isSystemKey(key) {
		return key.startsWith("/:");
	}
}
