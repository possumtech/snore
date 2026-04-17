import { countTokens } from "../../agent/tokens.js";

const CEILING_RATIO = Number(process.env.RUMMY_BUDGET_CEILING);
if (!CEILING_RATIO) throw new Error("RUMMY_BUDGET_CEILING must be set");

function measureMessages(messages) {
	return messages.reduce((sum, m) => sum + countTokens(m.content), 0);
}

export default class Budget {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({
			name: "budget",
			modelVisible: 1,
			category: "logging",
		});
		core.hooks.tools.onView("budget", (entry) => entry.body);
		core.hooks.budget = {
			enforce: this.enforce.bind(this),
			postDispatch: this.postDispatch.bind(this),
		};
	}

	async enforce({ contextSize, messages, rows, lastPromptTokens = 0 }) {
		if (!contextSize) {
			return { messages, rows, demoted: [], assembledTokens: 0, status: 200 };
		}

		const assembledTokens =
			lastPromptTokens > 0 ? lastPromptTokens : measureMessages(messages);

		console.warn(
			`[RUMMY] Budget enforce: ${assembledTokens} tokens (${lastPromptTokens > 0 ? "actual" : "estimated"}), ceiling ${contextSize}, ${rows.length} rows`,
		);

		const ceiling = Math.floor(contextSize * CEILING_RATIO);
		if (assembledTokens > ceiling) {
			const overflow = assembledTokens - ceiling;
			console.warn(
				`[RUMMY] Budget 413: ${assembledTokens} tokens > ${contextSize} ceiling (${overflow} over)`,
			);
			return {
				messages,
				rows,
				demoted: [],
				assembledTokens,
				status: 413,
				overflow,
			};
		}

		return { messages, rows, demoted: [], assembledTokens, status: 200 };
	}

	async postDispatch({
		contextSize,
		messages,
		rows,
		runId,
		loopId,
		turn,
		db,
		store,
	}) {
		if (!contextSize) return null;

		const postBudget = await this.enforce({
			contextSize,
			messages,
			rows,
			lastPromptTokens: 0,
		});

		if (postBudget.status !== 413) return null;

		// Demote this turn's entries
		const demotedEntries = await db.demote_turn_entries.all({
			run_id: runId,
			turn,
		});

		// Also demote the prompt
		const promptRow = rows.find((r) => r.scheme === "prompt");
		if (promptRow) {
			await store.setFidelity(runId, promptRow.path, "demoted");
		}

		// NOTE: we do NOT rewrite get-result bodies or flip their status.
		// The get succeeded (status=200); budget demotion is a lifecycle
		// event, not a failure of the get. The body still says "promoted"
		// (which was true at the moment of the get); fidelity=demoted tells
		// the model the entry is no longer in the promoted view. The budget://
		// entry is the canonical record of the panic. Model reads three
		// consistent signals: status=200 (get worked), fidelity=demoted (it's
		// out of context now), budget://... (this turn overflowed).

		// Write budget entry — terse, actionable. Path list dropped since
		// demoted entries already render at fidelity="demoted" in <knowns>/<files>.
		// "tokens remaining" dropped too — the number was over-optimistic (it
		// treated re-demoted files as freeing their full-body tokens when their
		// demoted-view renderings return to baseline). Model reads the truthful
		// remaining in next turn's progress line.
		//
		// The 50% rule is the key directive: it forces the model to sum
		// promotion costs (which is the behavior we want), and the threshold
		// gives a concrete ceiling for the next try. Twofer — abiding by the
		// rule requires budget awareness as a side effect.
		const ceiling = Math.floor(contextSize * CEILING_RATIO);
		const totalDemoted = demotedEntries.reduce((s, r) => s + r.tokens, 0);
		const body = [
			`413 Token Budget Error: overflowed by ${postBudget.overflow} tokens. Token Budget: ${ceiling}.`,
			`Your ${demotedEntries.length} promotions from last turn (${totalDemoted} tokens total) were demoted to fit.`,
			`Required: sum the tokens="N" of your promotions and new entries before emitting. A single turn must add no more than 50% of remaining Token Budget.`,
		].join("\n");

		await store.upsert(runId, turn, `budget://${loopId}/${turn}`, body, 413, {
			loopId,
		});
	}
}
