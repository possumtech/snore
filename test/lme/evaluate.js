/**
 * Pass/fail evaluation for LongMemEval.
 *
 * Each question has one or more valid answer strings.
 * A response passes if any valid answer appears as a substring
 * of the model's response (case-insensitive, trimmed).
 *
 * No fuzzy matching. No LLM judge. Strict containment.
 */

/**
 * @param {string} response - The model's response text.
 * @param {string[]} validAnswers - Acceptable answer strings.
 * @returns {{ pass: boolean, matched: string|null }}
 */
export function evaluate(response, validAnswers) {
	if (!response || !validAnswers?.length) return { pass: false, matched: null };

	const normalized = response.toLowerCase().trim();
	const unique = [
		...new Set(validAnswers.map((a) => a.trim()).filter(Boolean)),
	];

	for (const answer of unique) {
		if (normalized.includes(answer.toLowerCase())) {
			return { pass: true, matched: answer };
		}
	}

	return { pass: false, matched: null };
}

/**
 * Score a full benchmark row result.
 * @param {{ pass: boolean }[]} results
 * @returns {{ total: number, passed: number, failed: number, accuracy: number }}
 */
export function scoreRow(results) {
	const total = results.length;
	const passed = results.filter((r) => r.pass).length;
	return {
		total,
		passed,
		failed: total - passed,
		accuracy: total > 0 ? passed / total : 0,
	};
}
