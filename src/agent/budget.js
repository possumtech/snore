import { countTokens } from "./tokens.js";

const CEILING_RATIO = Number(process.env.RUMMY_BUDGET_CEILING);
if (!CEILING_RATIO) throw new Error("RUMMY_BUDGET_CEILING must be set");

export function ceiling(contextSize) {
	return Math.floor(contextSize * CEILING_RATIO);
}

/**
 * Sum assembled-message token counts.
 * Used by the budget enforce gate, which has the real messages.
 */
export function measureMessages(messages) {
	return messages.reduce((sum, m) => sum + countTokens(m.content), 0);
}

/**
 * Sum projected row body token counts — what's actually in the packet
 * for each entry at its current visibility. Used by prompt.js while
 * generating the <prompt> tag (before assembly completes).
 */
export function measureRows(rows) {
	return rows.reduce((sum, r) => sum + countTokens(r.body), 0);
}

/**
 * Single source of truth for budget numbers. Every caller — prompt.js
 * generating the <prompt> tag, budget.js enforcing the ceiling,
 * AgentLoop emitting telemetry — passes in its own measured totalTokens
 * and reads the same object back. No fallbacks: callers produce the
 * measurement they have.
 *
 * Returns:
 *   ceiling     — floor(contextSize × CEILING_RATIO), the hard wall
 *   totalTokens — echoed back (the full packet size the caller measured)
 *   tokenUsage  — same as totalTokens. Kept under this name for the
 *                 `<prompt tokenUsage="N">` attribute on the wire. Must
 *                 agree with totalTokens so the model's math is honest.
 *   tokensFree  — ceiling − totalTokens (floor 0)
 *   overflow    — max(0, totalTokens − ceiling)
 *   ok          — overflow === 0
 */
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
