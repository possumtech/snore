import config from "./config.js";
import { countTokens } from "./tokens.js";

const CEILING_RATIO = config.BUDGET_CEILING;

export function ceiling(contextSize) {
	return Math.floor(contextSize * CEILING_RATIO);
}

// Sum assembled-message token counts; used by the budget enforce gate.
export function measureMessages(messages) {
	return messages.reduce((sum, m) => sum + countTokens(m.content), 0);
}

// Sum projected row body token counts; used by prompt.js pre-assembly.
export function measureRows(rows) {
	return rows.reduce((sum, r) => sum + countTokens(r.body), 0);
}

// Single source of truth for budget numbers; tokenUsage echoes totalTokens for the wire attribute.
export function computeBudget({ contextSize, totalTokens }) {
	const cap = ceiling(contextSize);
	const tokensFree = Math.max(0, cap - totalTokens);
	const overflow = Math.max(0, totalTokens - cap);
	return {
		ceiling: cap,
		totalTokens,
		tokenUsage: totalTokens,
		tokensFree,
		overflow,
		ok: overflow === 0,
	};
}
