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
			BudgetExceeded,
		};
	}

	async enforce({ contextSize, messages, rows }) {
		if (!contextSize) {
			return { messages, rows, demoted: [], assembledTokens: 0, status: 200 };
		}

		const assembledTokens = measureMessages(messages);

		console.warn(
			`[RUMMY] Budget enforce: ${assembledTokens} tokens, ceiling ${contextSize}, ${rows.length} rows`,
		);

		if (assembledTokens > contextSize) {
			const overflow = assembledTokens - contextSize;
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
