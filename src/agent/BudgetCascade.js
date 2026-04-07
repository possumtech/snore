import { countTokens } from "./tokens.js";

/**
 * Budget cascade: guarantees materialized context fits within the model's
 * context window. Four tiers, each strictly smaller than the previous.
 *
 * Tier 1: full → summary
 * Tier 2: summary → index
 * Tier 3: index → stored, replaced by per-scheme stash entries (at index fidelity)
 * Tier 4: hard error — system prompt + stashes don't fit
 */

const DEMOTION_ORDER = {
	result: 0,
	structural: 0,
	file: 1,
	file_index: 1,
	file_summary: 1,
	known: 2,
	known_index: 2,
	unknown: 3,
};

function sortByDemotionPriority(entries) {
	return entries.toSorted((a, b) => {
		const tierA = DEMOTION_ORDER[a.category] ?? 99;
		const tierB = DEMOTION_ORDER[b.category] ?? 99;
		if (tierA !== tierB) return tierA - tierB;
		return a.source_turn - b.source_turn;
	});
}

function measureMessages(messages) {
	return messages.reduce((sum, m) => sum + countTokens(m.content || ""), 0);
}

export default class BudgetCascade {
	#db;
	#knownStore;

	constructor(db, knownStore) {
		this.#db = db;
		this.#knownStore = knownStore;
	}

	/**
	 * Enforce budget on assembled messages. Demotes entries through the
	 * cascade until the context fits. Returns { messages, rows, demoted }.
	 *
	 * @param {object} opts
	 * @param {number} opts.contextSize - model's context window
	 * @param {number} opts.runId
	 * @param {number} opts.loopId
	 * @param {number} opts.turn
	 * @param {object[]} opts.messages - assembled messages
	 * @param {object[]} opts.rows - turn_context rows
	 * @param {Function} opts.rematerialize - async fn to rematerialize and reassemble
	 */
	async enforce({
		contextSize,
		runId,
		loopId,
		turn,
		messages,
		rows,
		rematerialize,
	}) {
		if (!contextSize) return { messages, rows, demoted: [] };

		const ceiling = contextSize * 0.95;
		const demoted = [];
		let assembledTokens = measureMessages(messages);
		let currentMessages = messages;
		let currentRows = rows;

		const refresh = async () => {
			const result = await rematerialize();
			currentMessages = result.messages;
			currentRows = result.rows;
			assembledTokens = measureMessages(currentMessages);
		};

		// Tier 1: Full → summary
		if (assembledTokens > ceiling) {
			const candidates = sortByDemotionPriority(
				currentRows.filter(
					(r) =>
						r.fidelity === "full" &&
						r.tokens > 0 &&
						DEMOTION_ORDER[r.category] !== undefined,
				),
			);
			const target = (assembledTokens - ceiling) * 1.1;
			let accumulated = 0;
			for (const entry of candidates) {
				if (accumulated >= target) break;
				await this.#knownStore.setFidelity(runId, entry.path, "summary");
				accumulated += entry.tokens;
				demoted.push(entry.path);
			}
			if (demoted.length > 0) {
				await refresh();
				console.warn(
					`[RUMMY] Budget tier 1: ${demoted.length} full→summary (${assembledTokens}/${contextSize} tokens)`,
				);
			}
		}

		// Tier 2: Summary → index
		if (assembledTokens > ceiling) {
			const candidates = sortByDemotionPriority(
				currentRows.filter(
					(r) =>
						r.fidelity === "summary" &&
						r.tokens > 0 &&
						DEMOTION_ORDER[r.category] !== undefined,
				),
			);
			const target = (assembledTokens - ceiling) * 1.1;
			let accumulated = 0;
			const tier2 = [];
			for (const entry of candidates) {
				if (accumulated >= target) break;
				await this.#knownStore.setFidelity(runId, entry.path, "index");
				accumulated += entry.tokens;
				tier2.push(entry.path);
				demoted.push(entry.path);
			}
			if (tier2.length > 0) {
				await refresh();
				console.warn(
					`[RUMMY] Budget tier 2: ${tier2.length} summary→index (${assembledTokens}/${contextSize} tokens)`,
				);
			}
		}

		// Tier 3: Index → stored, replaced by per-scheme stash entries at index fidelity
		if (assembledTokens > ceiling) {
			const candidates = sortByDemotionPriority(
				currentRows.filter(
					(r) =>
						r.fidelity === "index" &&
						DEMOTION_ORDER[r.category] !== undefined &&
						!r.path?.startsWith("known://stash_"),
				),
			);
			const tier3 = [];
			for (const entry of candidates) {
				await this.#knownStore.setFidelity(runId, entry.path, "stored");
				tier3.push(entry.path);
				demoted.push(entry.path);
			}
			if (tier3.length > 0) {
				await this.#createStashEntries(runId, turn, loopId);
				await refresh();
				console.warn(
					`[RUMMY] Budget tier 3: ${tier3.length} index→stashed (${assembledTokens}/${contextSize} tokens)`,
				);
			}
		}

		// Tier 4: Hard error — system prompt + stashes don't fit
		if (assembledTokens > ceiling) {
			throw new Error(
				`Context floor (${assembledTokens} tokens) exceeds model limit (${contextSize}). ` +
					"Reduce system prompt size or use a model with a larger context window.",
			);
		}

		return { messages: currentMessages, rows: currentRows, demoted };
	}

	/**
	 * Collapse stored entries into per-scheme stash entries at index fidelity.
	 * The stash body contains the full URI list. Fidelity is set to index
	 * so only the stash path is visible — the model promotes to full to see contents.
	 */
	async #createStashEntries(runId, turn, loopId) {
		const entries = await this.#db.get_known_entries.all({ run_id: runId });
		const stored = entries.filter(
			(e) =>
				e.fidelity === "stored" &&
				e.status === 200 &&
				!e.path?.startsWith("known://stash_"),
		);

		const byScheme = {};
		for (const entry of stored) {
			const scheme = entry.scheme || "file";
			byScheme[scheme] ??= [];
			byScheme[scheme].push(entry.path);
		}

		for (const [scheme, paths] of Object.entries(byScheme)) {
			const stashPath = `known://stash_${scheme}`;
			const body = paths.join("\n");
			await this.#knownStore.upsert(runId, turn, stashPath, body, 200, {
				fidelity: "index",
				loopId,
			});
		}
	}
}
