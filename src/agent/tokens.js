// Conservative chars/token approximation; RUMMY_TOKEN_DIVISOR controls the divisor.
const DIVISOR = Number(process.env.RUMMY_TOKEN_DIVISOR);
if (!DIVISOR) throw new Error("RUMMY_TOKEN_DIVISOR must be a non-zero number");

export function countTokens(text) {
	if (!text) return 0;
	return Math.ceil(text.length / DIVISOR);
}

export function countLines(text) {
	if (!text) return 0;
	const newlines = text.split("\n").length - 1;
	return text.endsWith("\n") ? newlines : newlines + 1;
}
