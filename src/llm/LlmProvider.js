import msg from "../agent/messages.js";
import {
	ContextExceededError,
	isContextExceededMessage,
	isTransientMessage,
} from "./errors.js";

const MAX_TRANSIENT_RETRIES = 3;

/**
 * Thin dispatcher over the LLM provider registry (`hooks.llm.providers`).
 * Resolves the model alias via the DB, finds the highest-priority provider
 * whose `matches()` returns true, and delegates. Wraps the call with
 * transient-error retry and surfaces context-exceeded as a typed
 * ContextExceededError.
 *
 * Vendor-specific HTTP is owned by per-vendor plugins under
 * `src/plugins/{openai,ollama,xai,openrouter,...}/`. Adding a new vendor
 * is a matter of adding a plugin — no changes here.
 */
export default class LlmProvider {
	#db;
	#hooks;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
	}

	async resolve(alias) {
		const row = await this.#db.get_model_by_alias.get({ alias });
		if (row) return row.actual;
		throw new Error(msg("error.model_alias_unknown", { alias }));
	}

	#selectProvider(modelAlias) {
		return this.#hooks.llm.providers.find((p) => p.matches(modelAlias));
	}

	async completion(messages, model, options = {}) {
		const resolvedModel = await this.resolve(model);

		const temperature =
			options.temperature ??
			(process.env.RUMMY_TEMPERATURE !== undefined
				? Number.parseFloat(process.env.RUMMY_TEMPERATURE)
				: undefined);
		const resolvedOptions = { ...options, temperature };

		const provider = this.#selectProvider(resolvedModel);
		if (!provider) {
			throw new Error(
				`No LLM provider registered for model "${resolvedModel}". ` +
					`Check your RUMMY_* env vars or register a provider plugin.`,
			);
		}

		for (let attempt = 0; ; attempt++) {
			try {
				return await provider.completion(
					messages,
					resolvedModel,
					resolvedOptions,
				);
			} catch (err) {
				if (isContextExceededMessage(err.message)) {
					throw new ContextExceededError(err.message, { cause: err });
				}
				if (
					isTransientMessage(err.message) &&
					attempt < MAX_TRANSIENT_RETRIES
				) {
					const delay = 1000 * 2 ** attempt;
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}
				throw err;
			}
		}
	}

	async getContextSize(model) {
		// DB is the authority — check models table first.
		if (this.#db) {
			const row = await this.#db.get_model_by_alias.get({ alias: model });
			if (row?.context_length) return row.context_length;
		}

		const resolvedModel = await this.resolve(model);
		const provider = this.#selectProvider(resolvedModel);
		if (!provider) {
			throw new Error(
				`No LLM provider registered for model "${resolvedModel}".`,
			);
		}
		const size = await provider.getContextSize(resolvedModel);

		// Cache back to DB for next time. Write failure shouldn't block
		// the caller — they already have `size`; the cache is advisory.
		if (this.#db && size) {
			try {
				await this.#db.update_model_context_length.run({
					alias: model,
					context_length: size,
				});
			} catch (err) {
				console.warn(`[RUMMY] model context cache write failed: ${err.message}`);
			}
		}

		return size;
	}
}
