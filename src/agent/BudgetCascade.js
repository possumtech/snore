import { countTokens } from "./tokens.js";

/**
 * Budget cascade: guarantees materialized context fits within the model's
 * context window. Context overflow is structurally impossible.
 *
 * Each tier uses iterative halving — demote the oldest half of eligible
 * entries, re-render, re-measure. Repeat until budget met or tier exhausted.
 * Most recent entries survive longest. In conflict-resolution scenarios,
 * later entries are authoritative.
 *
 * Tier 1: full → summary (halving spiral)
 * Tier 2: summary → index (halving spiral)
 * Tier 3: index → stash (halving spiral)
 * Tier 4: hard error
 */

// Demotion priority: shed data first, then reasoning, then narrative.
// Tier 0: files, URLs, entries — re-readable data
// Tier 1: knowns and unknowns — the model's reasoning state
// Tier 2: prompts and tool results — the model's narrative and action history
const DEMOTION_ORDER = {
	file: 0,
	file_index: 0,
	file_summary: 0,
	known: 1,
	known_index: 1,
	unknown: 1,
	result: 2,
	structural: 2,
	prompt: 2,
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
	 */
	async enforce({
		contextSize,
		runId,
		loopId,
		turn,
		messages,
		rows,
		rematerialize,
		summarize,
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

		// Tier 1: Full → summary (halving spiral)
		await this.#halvingSpiral({
			ceiling,
			assembledTokens: () => assembledTokens,
			refresh,
			demoted,
			runId,
			fidelityFrom: "full",
			fidelityTo: "summary",
			tier: 1,
			summarize,
			getCandidates: () =>
				sortByDemotionPriority(
					currentRows.filter(
						(r) =>
							r.fidelity === "full" &&
							r.tokens > 0 &&
							DEMOTION_ORDER[r.category] !== undefined,
					),
				),
		});

		// Tier 2: Summary → index (halving spiral)
		await this.#halvingSpiral({
			ceiling,
			assembledTokens: () => assembledTokens,
			refresh,
			demoted,
			runId,
			fidelityFrom: "summary",
			fidelityTo: "index",
			tier: 2,
			getCandidates: () =>
				sortByDemotionPriority(
					currentRows.filter(
						(r) =>
							r.fidelity === "summary" &&
							r.tokens > 0 &&
							DEMOTION_ORDER[r.category] !== undefined,
					),
				),
		});

		// Tier 3: Index → stash (halving spiral)
		await this.#stashSpiral({
			ceiling,
			assembledTokens: () => assembledTokens,
			refresh,
			demoted,
			runId,
			turn,
			loopId,
			getCandidates: () =>
				sortByDemotionPriority(
					currentRows.filter(
						(r) =>
							r.fidelity === "index" &&
							DEMOTION_ORDER[r.category] !== undefined &&
							!r.path?.startsWith("known://stash_"),
					),
				),
		});

		// Tier 4: Hard error
		if (assembledTokens > ceiling) {
			throw new Error(
				`Context floor (${assembledTokens} tokens) exceeds model limit (${contextSize}). ` +
					"Reduce system prompt size or use a model with a larger context window.",
			);
		}

		return { messages: currentMessages, rows: currentRows, demoted };
	}

	/**
	 * Iterative halving: demote oldest half of eligible entries,
	 * re-render, re-measure. Repeat until budget met or nothing left.
	 */
	async #halvingSpiral({
		ceiling,
		assembledTokens,
		refresh,
		demoted,
		runId,
		fidelityFrom,
		fidelityTo,
		tier,
		getCandidates,
		summarize,
	}) {
		let iteration = 0;
		while (assembledTokens() > ceiling) {
			const candidates = getCandidates();
			if (candidates.length === 0) break;

			const half = Math.max(1, Math.ceil(candidates.length / 2));
			const toDemote = candidates.slice(0, half);
			const batch = [];

			for (const entry of toDemote) {
				await this.#knownStore.setFidelity(runId, entry.path, fidelityTo);
				batch.push(entry.path);
				demoted.push(entry.path);
			}

			if (fidelityTo === "summary" && summarize) {
				const needsSummary = toDemote.filter((e) => {
					const attrs =
						typeof e.attributes === "string"
							? JSON.parse(e.attributes)
							: e.attributes;
					return !attrs?.summary;
				});
				if (needsSummary.length > 0) {
					await summarize(needsSummary);
				}
			}

			await refresh();
			iteration++;
			console.warn(
				`[RUMMY] Budget tier ${tier}: ${batch.length} ${fidelityFrom}→${fidelityTo} (${assembledTokens()}/${ceiling | 0} tokens, pass ${iteration})`,
			);
		}
	}

	/**
	 * Stash spiral: like halving, but stashed entries get collapsed
	 * into per-scheme stash entries at index fidelity.
	 */
	async #stashSpiral({
		ceiling,
		assembledTokens,
		refresh,
		demoted,
		runId,
		turn,
		loopId,
		getCandidates,
	}) {
		let iteration = 0;
		while (assembledTokens() > ceiling) {
			const candidates = getCandidates();
			if (candidates.length === 0) break;

			const half = Math.max(1, Math.ceil(candidates.length / 2));
			const toDemote = candidates.slice(0, half);
			const batch = [];

			for (const entry of toDemote) {
				await this.#knownStore.setFidelity(runId, entry.path, "stored");
				batch.push(entry.path);
				demoted.push(entry.path);
			}

			await this.#createStashEntries(runId, turn, loopId);
			await refresh();
			iteration++;
			console.warn(
				`[RUMMY] Budget tier 3: ${batch.length} index→stashed (${assembledTokens()}/${ceiling | 0} tokens, pass ${iteration})`,
			);
		}
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
