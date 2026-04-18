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
	return CONTEXT_EXCEEDED_PATTERN.test(String(message || ""));
}

const TRANSIENT_PATTERN =
	/\b(503|429|timeout|ECONNREFUSED|ECONNRESET|unavailable)\b/i;

export function isTransientMessage(message) {
	return TRANSIENT_PATTERN.test(String(message || ""));
}
