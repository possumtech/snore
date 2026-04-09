import slugify from "../sql/functions/slugify.js";
import BudgetGuard from "./BudgetGuard.js";

export default class KnownStore {
	#db;
	#onChanged;
	#budgetGuard = null;
	#schemes = new Map();

	constructor(db, { onChanged } = {}) {
		this.#db = db;
		this.#onChanged = onChanged || null;
	}

	get budgetGuard() {
		return this.#budgetGuard;
	}

	set budgetGuard(guard) {
		this.#budgetGuard = guard;
	}

	async loadSchemes(db) {
		const rows = await (db || this.#db).get_all_schemes.all();
		this.#schemes.clear();
		for (const row of rows) {
			this.#schemes.set(row.name, row);
		}
	}

	#isVisible(path, fidelity) {
		if (fidelity === "stored") return false;
		const scheme = KnownStore.scheme(path) ?? "file";
		const meta = this.#schemes.get(scheme);
		return meta ? meta.model_visible !== 0 : true;
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
		return path.replace(/:\/\/(.*)$/, (_, rest) => {
			try {
				// Decode first (idempotent), then encode — but preserve slashes
				const decoded = decodeURIComponent(rest);
				return `://${decoded.split("/").map(encodeURIComponent).join("/")}`;
			} catch {
				return `://${rest.split("/").map(encodeURIComponent).join("/")}`;
			}
		});
	}

	async nextTurn(runId) {
		const row = await this.#db.next_turn.get({ run_id: runId });
		return row.turn;
	}

	async dedup(runId, scheme, target) {
		const encodedTarget = encodeURIComponent(target);
		const candidate = `${scheme}://${encodedTarget}`;
		const existing = await this.#db.get_entry_body.get({
			run_id: runId,
			path: candidate,
		});
		if (!existing) return candidate;
		return `${candidate}_${Date.now()}`;
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
		let delta = 0;

		if (
			this.#budgetGuard &&
			status < 400 &&
			this.#isVisible(normalized, fidelity)
		) {
			const existing = await this.#db.get_entry_body.get({
				run_id: runId,
				path: normalized,
			});
			delta = BudgetGuard.delta(body, existing?.body);
			this.#budgetGuard.check(delta, normalized);
		}

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

		if (delta > 0) this.#budgetGuard?.charge(delta);
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
		let cost = 0;
		if (this.#budgetGuard) {
			const entries = await this.#db.get_entries_by_pattern.all({
				run_id: runId,
				path,
				body: KnownStore.#bodyPattern(body),
				limit: null,
				offset: null,
			});
			cost = entries
				.filter((e) => e.fidelity === "stored" || e.fidelity === "index")
				.reduce((sum, e) => sum + (e.tokens_full || 0), 0);
			if (cost > 0) this.#budgetGuard.check(cost, path);
		}

		await this.#db.promote_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
			turn,
		});
		this.#emitChanged(runId, path, "promote");

		if (cost > 0) this.#budgetGuard?.charge(cost);
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
		let delta = 0;
		if (this.#budgetGuard) {
			const entries = await this.#db.get_entries_by_pattern.all({
				run_id: runId,
				path,
				body: KnownStore.#bodyPattern(body),
				limit: null,
				offset: null,
			});
			const visible = entries.filter((e) =>
				this.#isVisible(e.path, e.fidelity),
			);
			const oldTotal = visible.reduce((sum, e) => sum + (e.tokens || 0), 0);
			const newTokensPer = BudgetGuard.delta(newBody, null);
			delta = newTokensPer * visible.length - oldTotal;
			if (delta > 0) this.#budgetGuard.check(delta, path);
		}

		await this.#db.update_body_by_pattern.run({
			run_id: runId,
			path,
			body: KnownStore.#bodyPattern(body),
			new_body: newBody,
		});
		this.#emitChanged(runId, path, "body");

		if (delta > 0) this.#budgetGuard?.charge(delta);
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
