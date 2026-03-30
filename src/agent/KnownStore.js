import { countTokens } from "./tokens.js";

export default class KnownStore {
	#db;

	constructor(db) {
		this.#db = db;
	}

	static domain(key) {
		if (key.startsWith("/:known:") || key.startsWith("/:unknown:"))
			return "known";
		if (key.startsWith("/:")) return "result";
		return "file";
	}

	async nextTurn(runId) {
		const row = await this.#db.next_turn.get({ run_id: runId });
		return row.turn;
	}

	async nextResultKey(runId, toolName) {
		const row = await this.#db.next_result_key.get({ run_id: runId });
		return `/:${toolName}:${row.seq}`;
	}

	async upsert(
		runId,
		turn,
		key,
		value,
		state,
		{ meta = null, hash = null, updatedAt = null } = {},
	) {
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
			updated_at: updatedAt,
		});
	}

	async promote(runId, key, turn) {
		await this.#db.promote_key.run({ run_id: runId, key, turn });
	}

	async setFileState(runId, key, state) {
		await this.#db.set_file_state.run({ run_id: runId, key, state });
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

	/**
	 * Build the ordered model context array.
	 * Each bucket is a separate SQL query. No full-table scan.
	 *
	 * Order:
	 *   1. Active known (/:known:* at turn > 0)
	 *   2. Stored known (/:known:* at turn 0)
	 *   3. Stored file paths (turn 0, not symbols, not ignore)
	 *   4. Symbol files
	 *   5. Full files (turn > 0, not ignore)
	 *   6. Chronological results (not proposed)
	 *   7. Unknowns (/:unknown:*)
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

		// 4. Symbol files — value from meta.symbols, never raw file content
		for (const r of await this.#db.get_symbol_files.all({ run_id: runId })) {
			const meta = r.meta ? JSON.parse(r.meta) : null;
			context.push({
				key: r.key,
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
				key: r.key,
				state: fileState,
				value: r.value,
				tokens: r.tokens,
			});
		}

		// 6. Chronological results — filtered by tool type
		for (const r of await this.#db.get_results.all({ run_id: runId })) {
			const tool = KnownStore.toolFromKey(r.key);
			const meta = r.meta ? JSON.parse(r.meta) : {};
			const target =
				meta.command || meta.file || meta.key || meta.question || "";

			// What the model sees depends on the tool type:
			// summary: full text
			// env/run/ask_user: command/question + output/answer (value)
			// edit: search/replace blocks from meta
			// write: key only (value already in known section)
			// read/drop: key only
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
				key: r.key,
				state: r.state,
				value,
				tool: tool || r.state,
				target,
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
			const target =
				meta.command || meta.file || meta.key || meta.question || "";

			let value = "";
			if (row.state === "summary") value = row.value;
			else if (tool === "env" || tool === "run" || tool === "ask_user")
				value = row.value;

			return {
				tool: tool || row.state,
				target,
				status: row.state,
				key: row.key,
				value,
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

	async getValue(runId, key) {
		const row = await this.#db.get_entry_value.get({ run_id: runId, key });
		return row?.value ?? null;
	}

	async getMeta(runId, key) {
		const row = await this.#db.get_entry_meta.get({ run_id: runId, key });
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

		// Batch encode — one pass through the encoder
		const updates = rows.map((row) => ({
			key: row.key,
			tokens: countTokens(row.value),
		}));

		// Bulk write
		for (const { key, tokens } of updates) {
			await this.#db.recount_tokens.run({ run_id: runId, key, tokens });
		}
	}

	static toolFromKey(key) {
		const match = key.match(/^\/:([a-z_]+):/);
		return match ? match[1] : null;
	}

	static isSystemKey(key) {
		return key.startsWith("/:");
	}
}
