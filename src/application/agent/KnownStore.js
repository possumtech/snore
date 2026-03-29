export default class KnownStore {
	#db;

	constructor(db) {
		this.#db = db;
	}

	static domain(key) {
		if (key.startsWith("/:known/") || key === "/:unknown") return "known";
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
		await this.#db.resolve_known_entry.run({
			run_id: runId,
			key,
			state,
			value,
		});
	}

	async getAll(runId) {
		return this.#db.get_known_entries.all({ run_id: runId });
	}

	/**
	 * Build the ordered model context array.
	 * One flat list. No separate sections. Order is the attention gradient:
	 *
	 *   1. Active non-file keys (/:known/* at turn > 0)
	 *   2. Stored non-file keys (/:known/* at turn 0)
	 *   3. Stored file paths (files at turn 0)
	 *   4. Symbol files (files with symbols state)
	 *   5. Full files (files at turn > 0)
	 *   6. Chronological tool + summary results
	 *   7. Last turn's unknowns
	 *   8. Most recent user prompt
	 */
	async getModelContext(runId) {
		const rows = await this.getAll(runId);

		const activeKnown = [];
		const storedKnown = [];
		const storedFiles = [];
		const symbolFiles = [];
		const fullFiles = [];
		const results = [];
		let unknowns = null;
		let prompt = null;

		for (const row of rows) {
			// Hide internals
			if (row.key.startsWith("/:system/")) continue;
			if (row.key.startsWith("/:user/")) continue;
			if (row.key.startsWith("/:reasoning/")) continue;
			if (row.domain === "file" && row.state === "ignore") continue;
			if (row.domain === "result" && row.state === "proposed") continue;

			const expanded = row.turn > 0;

			// Unknowns — collect for position 7
			if (row.key === "/:unknown") {
				try {
					const items = JSON.parse(row.value || "[]");
					unknowns = items.map((text) => ({ key: "/:unknown", state: "unknown", value: text }));
				} catch {
					unknowns = [{ key: "/:unknown", state: "unknown", value: row.value }];
				}
				continue;
			}

			// User prompt — collect for position 8
			if (row.key.startsWith("/:prompt/")) {
				prompt = row;
				continue;
			}

			// Knowledge entries
			if (row.domain === "known") {
				if (expanded) {
					activeKnown.push({ key: row.key, state: "full", value: row.value });
				} else {
					storedKnown.push({ key: row.key, state: "stored", value: "" });
				}
				continue;
			}

			// File entries
			if (row.domain === "file") {
				if (expanded) {
					const fileState = row.state === "readonly" ? "file:readonly"
						: row.state === "active" ? "file:active"
						: "file";
					fullFiles.push({ key: row.key, state: fileState, value: row.value });
				} else if (row.state === "symbols") {
					const meta = row.meta ? JSON.parse(row.meta) : null;
					symbolFiles.push({
						key: row.key,
						state: "file:symbols",
						value: meta?.symbols || row.value || "",
					});
				} else {
					storedFiles.push({ key: row.key, state: "file:path", value: "" });
				}
				continue;
			}

			// Result entries (tool calls, summaries) — chronological by id
			if (row.domain === "result") {
				const tool = KnownStore.toolFromKey(row.key);
				const meta = row.meta ? JSON.parse(row.meta) : {};
				results.push({
					key: row.key,
					state: row.state,
					value: row.state === "summary" ? row.value : "",
					tool: tool || row.state,
					target: meta.command || meta.file || meta.key || meta.question || "",
				});
				continue;
			}
		}

		// Assemble in order
		const context = [
			...activeKnown,
			...storedKnown,
			...storedFiles,
			...symbolFiles,
			...fullFiles,
			...results,
		];

		if (unknowns) context.push(...unknowns);

		// Most recent prompt last
		if (prompt) {
			context.push({ key: prompt.key, state: "prompt", value: prompt.value });
		}

		return context;
	}

	/**
	 * Get the chronological log (result-domain entries).
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

	static toolFromKey(key) {
		const match = key.match(/^\/:([a-z_]+)\//);
		return match ? match[1] : null;
	}

	static isSystemKey(key) {
		return key.startsWith("/:");
	}
}
