import { countTokens } from "./tokens.js";

const CEILING_RATIO = Number(process.env.RUMMY_BUDGET_CEILING);
if (!CEILING_RATIO) throw new Error("RUMMY_BUDGET_CEILING must be set");

/**
 * Single source of truth for budget math. Every budget-related number
 * — the <prompt> tag attrs shown to the model, the 413 enforcement
 * gate, the statusline telemetry — derives from this one function.
 *
 * `totalTokens` is the assembled-context size. Callers with a measured
 * value (budget enforce, post-turn emit) pass `assembledTokens`.
 * Callers that don't yet have an assembly (prompt.js generating the
 * <prompt> tag during assembly) pass `messages=null` and get an
 * approximation based on row token sums. The CEILING_RATIO headroom
 * absorbs the per-entry tag/separator overhead that row tokens miss.
 *
 * Returns:
 *   ceiling        — floor(contextSize × CEILING_RATIO), the hard wall
 *   totalTokens    — assembled tokens (measured if provided, else summed)
 *   tokenUsage     — sum of promoted controllable entries' tokens
 *                    (data + logging, fidelity=promoted)
 *   tokensFree     — ceiling − totalTokens
 *   overflow       — max(0, totalTokens − ceiling)
 *   ok             — overflow === 0
 */
export function computeBudget({
	rows,
	contextSize,
	messages = null,
	assembledTokens = null,
}) {
	const ceiling = Math.floor(contextSize * CEILING_RATIO);
	const measured =
		assembledTokens ??
		(messages
			? messages.reduce((sum, m) => sum + countTokens(m.content), 0)
			: null);
	const totalTokens =
		measured ?? rows.reduce((s, r) => s + (r.tokens || 0), 0);
	const tokenUsage = rows.reduce((sum, r) => {
		if (
			(r.category === "data" || r.category === "logging") &&
			r.fidelity === "promoted"
		) {
			return sum + (r.tokens || 0);
		}
		return sum;
	}, 0);
	const tokensFree = Math.max(0, ceiling - totalTokens);
	const overflow = Math.max(0, totalTokens - ceiling);
	return { ceiling, totalTokens, tokenUsage, tokensFree, overflow, ok: overflow === 0 };
}
