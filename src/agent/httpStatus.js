/**
 * Map the entry-layer (state, outcome) tuple to an HTTP status number for
 * model-facing tag rendering.
 *
 * Model-facing tags still carry `status="NNN"` because the model's
 * vocabulary (preamble + tooldocs + training) is HTTP-shaped. The DB
 * stores categorical state + textual outcome (SPEC §0.1); this helper
 * is the one-way translation for rendering.
 *
 * Outcome strings prefixed with a 3-digit HTTP code (e.g.
 * `"overflow:413:..."` or `"permission:403:..."`) extract the code
 * verbatim. Otherwise state maps to a canonical HTTP:
 *
 *   resolved   → 200
 *   proposed   → 202
 *   streaming  → 102
 *   cancelled  → 499
 *   failed     → 500 (unless outcome carries a code)
 */
export function stateToStatus(state, outcome = null) {
	if (outcome) {
		const match = /(\d{3})/.exec(outcome);
		if (match) return Number(match[1]);
	}
	switch (state) {
		case "resolved":
			return 200;
		case "proposed":
			return 202;
		case "streaming":
			return 102;
		case "cancelled":
			return 499;
		case "failed":
			return 500;
		default:
			throw new Error(`stateToStatus: unknown state "${state}"`);
	}
}
