/**
 * Token counting with tiktoken (o200k_base) and simple fallback.
 * o200k_base is the tokenizer for GPT-4o and newer OpenAI models.
 * Better multilingual and code handling than cl100k_base.
 * Exact counts vary by model tokenizer — these are for budgeting, not billing.
 */

let encoder = null;

try {
	const tiktoken = await import("tiktoken");
	encoder = tiktoken.get_encoding("o200k_base");
} catch {
	// tiktoken unavailable — use character-based estimate
}

export function countTokens(text) {
	if (!text) return 0;
	if (encoder) {
		try {
			const tokens = encoder.encode(text);
			return tokens.length;
		} catch {
			// Fallback on encoding error
		}
	}
	return Math.ceil(text.length / 4);
}
