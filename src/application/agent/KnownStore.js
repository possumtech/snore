export default class KnownStore {
	#db;

	constructor(db) {
		this.#db = db;
	}

	/**
	 * Determine domain from key prefix.
	 * /: prefix = system key. Bare path = file.
	 */
	static domain(key) {
		if (key.startsWith("/:known/")) return "known";
		if (key.startsWith("/:")) return "result";
		return "file";
	}

	/**
	 * Generate the next result key for a tool call.
	 * Returns e.g. "/:read/4", "/:edit/7".
	 */
	async nextResultKey(runId, toolName) {
		const row = await this.#db.next_result_key.get({ run_id: runId });
		return `/:${toolName}/${row.seq}`;
	}

	/**
	 * UPSERT an entry. Domain is derived from the key.
	 * @param {string} runId
	 * @param {number|null} turnId
	 * @param {string} key
	 * @param {string} value
	 * @param {string} state
	 * @param {object|null} meta - JSON-serializable metadata (symbols, tool args, etc.)
	 */
	async upsert(runId, turnId, key, value, state, meta = null) {
		const domain = KnownStore.domain(key);
		await this.#db.upsert_known_entry.run({
			run_id: runId,
			turn_id: turnId,
			key,
			value,
			domain,
			state,
			meta: meta ? JSON.stringify(meta) : null,
		});
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
	 * Get all entries for a run.
	 * Returns raw rows: [{key, domain, state, value, meta}]
	 */
	async getAll(runId) {
		return this.#db.get_known_entries.all({ run_id: runId });
	}

	/**
	 * Get the model-facing known result.
	 * Projects domain:state into the model's simplified state string.
	 * Hides file:ignore and proposed entries.
	 */
	async getModelEntries(runId) {
		const rows = await this.getAll(runId);
		const entries = [];
		for (const row of rows) {
			const modelState = KnownStore.modelState(row.domain, row.state);
			if (!modelState) continue;
			entries.push({ key: row.key, state: modelState, value: row.value });
		}
		return entries;
	}

	/**
	 * Get the chronological log (summary tool result).
	 * Returns all result-domain entries ordered by id.
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
	 * Map internal domain:state to model-facing state string.
	 * Returns null for entries that should be hidden from the model.
	 */
	static modelState(domain, state) {
		if (domain === "file") {
			if (state === "ignore") return null;
			if (state === "symbols") return "file:symbols";
			if (state === "readonly") return "file:readonly";
			if (state === "active") return "file:active";
			return "file";
		}
		if (domain === "known") return state;
		if (domain === "result") {
			if (state === "proposed") return null;
			return "stored";
		}
		return null;
	}

	/**
	 * Extract tool name from a result key.
	 * "/:read/4" -> "read", "/:edit/7" -> "edit"
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
