export class ContextExceededError extends Error {
	constructor(message, { cause } = {}) {
		super(message);
		this.name = "ContextExceededError";
		if (cause) this.cause = cause;
	}
}

const CONTEXT_EXCEEDED_PATTERN =
	/\b(context.*(size|length|limit)|token.*(limit|exceed)|too.*(long|large))\b/i;

export function isContextExceededMessage(message) {
	return CONTEXT_EXCEEDED_PATTERN.test(String(message));
}

const ABORT_PATTERN = /\b(aborted|AbortError|TimeoutError)\b/;
// `terminated` is undici's err.message when the underlying socket closes
// mid-fetch (TLSSocket.onHttpSocketClose → Fetch.onAborted) — same lane
// as ECONNRESET, just surfaced through a streaming-fetch path.
const GATEWAY_PATTERN =
	/\b(502|504|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EPIPE|ECONNABORTED|fetch failed|terminated)\b/i;
const RATE_LIMIT_PATTERN = /\b429\b/;
const STATUS_503_PATTERN = /\b503\b/;
const STATUS_500_PATTERN = /\b500\b/;
// llamacpp / OpenAI-compatible servers signal model-warmup with this body.
const MODEL_WARMUP_PATTERN = /\bLoading model\b/i;

// Returns "gateway" | "warmup" | "rate_limit" | "server" | null.
// null = do not retry, propagate immediately. Operator/internal aborts,
// auth failures, malformed-request errors, unknown shapes all fall here.
export function classifyTransient(err) {
	if (!err || typeof err.message !== "string") return null;
	const { message } = err;

	if (ABORT_PATTERN.test(message)) return null;
	if (GATEWAY_PATTERN.test(message)) return "gateway";
	if (RATE_LIMIT_PATTERN.test(message)) return "rate_limit";
	if (STATUS_503_PATTERN.test(message)) {
		// 503 + explicit warmup signal → wait it out.
		if (MODEL_WARMUP_PATTERN.test(message)) return "warmup";
		if (typeof err.body === "string" && MODEL_WARMUP_PATTERN.test(err.body)) {
			return "warmup";
		}
		return "server";
	}
	if (STATUS_500_PATTERN.test(message)) return "server";
	return null;
}

// HTTP Retry-After: integer seconds (most common form). Returns
// undefined for missing, malformed, or HTTP-date forms — callers
// fall through to backoff in those cases.
export function parseRetryAfter(value) {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds;
	return undefined;
}
