import { countTokens } from "../../agent/tokens.js";

export default class Engine {
	static register(hooks) {
		hooks.onTurn(async (rummy) => {
			if (!rummy.contextSize) return;

			const { runId, sequence, store, db } = rummy;

			// Budget enforcement (skip in lite mode — no files to demote)
			if (!rummy.noContext) {
				const { total } = await db.get_promoted_token_total.get({
					run_id: runId,
				});
				if (total > rummy.contextSize) {
					const entries = await db.get_promoted_entries.all({
						run_id: runId,
					});
					const demoted = await enforce(
						store,
						runId,
						sequence,
						rummy.contextSize,
						total,
						entries,
					);
					if (demoted.length > 0) {
						const saved = demoted.reduce((s, d) => s + d.saved, 0);
						const before = ((total / rummy.contextSize) * 100) | 0;
						const after = (((total - saved) / rummy.contextSize) * 100) | 0;
						const names = demoted.map((d) => d.path).join(", ");
						console.log(
							`[ENGINE] Demoted: ${names} (budget: ${before}% → ${after}%)`,
						);
					}
				}
			}

			// Materialize turn_context: clear, system prompt, VIEW rows, continuation
			await db.clear_turn_context.run({ run_id: runId, turn: sequence });

			if (rummy.systemPrompt) {
				await db.insert_turn_context.run({
					run_id: runId,
					turn: sequence,
					ordinal: 0,
					path: "system://prompt",
					fidelity: "full",
					body: rummy.systemPrompt,
					tokens: countTokens(rummy.systemPrompt),
					attributes: null,
					category: "system",
				});
			}

			await db.materialize_turn_context.run({
				run_id: runId,
				turn: sequence,
			});

			// prompt:// and progress:// entries are already in known_entries
			// (stored by TurnExecutor before engine runs) and materialized
			// via v_model_context. No synthetic injection needed.
		}, 20);
	}
}

// --- Budget enforcement ---

async function enforce(store, runId, currentTurn, budget, total, entries) {
	const candidates = entries.filter((e) => e.turn !== currentTurn);

	const demoted = [];
	let remaining = total;

	for (const entry of candidates) {
		if (remaining <= budget) break;

		if (entry.tier === 1) {
			const before = entry.tokens;
			await store.setFileState(runId, entry.path, "summary");
			const attrs = await store.getAttributes(runId, entry.path);
			const symbolsTokens = ((attrs?.symbols?.length ?? 0) / 4) | 0;
			const saved = before - symbolsTokens;
			remaining -= saved;
			demoted.push({ path: entry.path, saved });
			continue;
		}

		remaining -= entry.tokens;
		await store.demote(runId, entry.path);
		demoted.push({ path: entry.path, saved: entry.tokens });
	}

	return demoted;
}
