/**
 * Token estimation. Conservative character-based approximation.
 * RUMMY_TOKEN_DIVISOR controls characters per token.
 * No external dependencies. The budget contract is exact.
 * contextSize is the ceiling. countTokens is the measurement.
 */

const DIVISOR = Number(process.env.RUMMY_TOKEN_DIVISOR);

export function countTokens(text) {
	if (!text) return 0;
	return Math.ceil(text.length / DIVISOR);
}
