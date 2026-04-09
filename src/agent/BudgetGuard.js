import { countTokens } from "./tokens.js";

export class BudgetExceeded extends Error {
	constructor(path, requested, remaining) {
		super(
			`Budget exceeded: ${path} needs ${requested} tokens, ${remaining} remaining`,
		);
		this.name = "BudgetExceeded";
		this.status = 413;
		this.path = path;
		this.requested = requested;
		this.remaining = remaining;
	}
}

export default class BudgetGuard {
	#ceiling;
	#baseline;
	#spent;
	#tripped;
	#tripSource;

	constructor(ceiling, baseline) {
		this.#ceiling = ceiling ?? null;
		this.#baseline = baseline;
		this.#spent = 0;
		this.#tripped = false;
		this.#tripSource = null;
	}

	get isTripped() {
		return this.#tripped;
	}

	get tripSource() {
		return this.#tripSource;
	}

	get remaining() {
		if (this.#ceiling === null) return Infinity;
		return this.#ceiling - this.#baseline - this.#spent;
	}

	get spent() {
		return this.#spent;
	}

	check(tokens, path) {
		if (this.#ceiling === null) return;
		if (this.#tripped) throw new BudgetExceeded(path, tokens, 0);
		if (tokens <= 0) return;
		const remaining = this.remaining;
		if (tokens > remaining) throw new BudgetExceeded(path, tokens, remaining);
	}

	charge(tokens) {
		if (tokens > 0) this.#spent += tokens;
	}

	trip(source) {
		this.#tripped = true;
		this.#tripSource = source;
	}

	/**
	 * Compute the token delta for an upsert. New entry = full cost.
	 * Update = difference between new and old body.
	 */
	static delta(newBody, existingBody) {
		const newTokens = countTokens(newBody);
		const oldTokens = existingBody ? countTokens(existingBody) : 0;
		return newTokens - oldTokens;
	}
}
