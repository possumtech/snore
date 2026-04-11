import { countTokens } from "../../agent/tokens.js";
import BudgetGuard, { BudgetExceeded } from "./BudgetGuard.js";

function measureMessages(messages) {
	return messages.reduce((sum, m) => sum + countTokens(m.content), 0);
}

export { BudgetExceeded };

export default class Budget {
	#core;

	constructor(core) {
		this.#core = core;
		core.hooks.budget = {
			enforce: this.enforce.bind(this),
			activate: this.activate.bind(this),
			deactivate: this.deactivate.bind(this),
			panicPrompt: Budget.panicPrompt,
			BudgetExceeded,
		};
	}

	static panicPrompt({ assembledTokens, panicTarget, continuation = false }) {
		const mustFree = assembledTokens - panicTarget;
		return [
			`CONTEXT OVERFLOW: YOU MUST free up at least ${mustFree} tokens to continue.`,
			"",
			"Entries in <knowns> and <previous> each show their current fidelity and token size. Reduce their fidelity to free up space.",
			"Target the largest and/or least relevant entries first.",
			'<set path="known://topic" fidelity="summary" summary="keyword1,keyword2,keyword3"/> to compress an entry.',
			'<set path="prompt://3" fidelity="index"/> to compress an entry — preferred, keeps path visible for later retrieval.',
			'<set path="known://topic" fidelity="archive"/> to remove from context — use only if the entry is truly irrelevant.',
			"Use quality keywords from the entry to describe the content.",
			continuation
				? "<update></update> to report progress, <summarize></summarize> when done."
				: "<summarize></summarize> when done. <update></update> if still working.",
		].join("\n");
	}

	async enforce({ contextSize, messages, rows }) {
		if (!contextSize) {
			return { messages, rows, demoted: [], assembledTokens: 0, status: 200 };
		}

		const assembledTokens = measureMessages(messages);

		console.warn(
			`[RUMMY] Budget enforce: ${assembledTokens} tokens, ceiling ${contextSize}, ${rows.length} rows`,
		);

		const ceiling = Math.floor(contextSize * 0.9);
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

	activate(store, contextSize, assembledTokens) {
		const guard = new BudgetGuard(Math.floor(contextSize * 0.9) - 500, assembledTokens);
		store.budgetGuard = guard;
		return guard;
	}

	deactivate(store) {
		store.budgetGuard = null;
	}
}
