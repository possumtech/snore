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

	static panicPrompt({ assembledTokens, contextSize, continuation = false }) {
		const target = Math.floor(contextSize * 0.5);
		const mustFree = assembledTokens - target;
		return [
			`CONTEXT OVERFLOW: ${assembledTokens} tokens, ceiling ${contextSize}.`,
			`YOU MUST free ${mustFree} tokens to get below ${target} (50%).`,
			"YOU MUST NOT load or create new content. Only reduce.",
			"",
			"<knowns> above shows each entry with its token count (0 = already minimal).",
			"Target the largest entries first.",
			"Copy the path attribute EXACTLY from <knowns> — do not invent paths.",
			'<rm path="..."/> to delete entries you no longer need.',
			'<set path="..." fidelity="summary" summary="keywords"/> to compress.',
			'<set path="..." fidelity="archive"/> to archive out of context.',
			continuation
				? "<update/> to report progress, <summarize/> when done."
				: "<summarize/> when done. <update/> if still working.",
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
		const guard = new BudgetGuard(contextSize, assembledTokens);
		store.budgetGuard = guard;
		return guard;
	}

	deactivate(store) {
		store.budgetGuard = null;
	}
}
