import msg from "../agent/messages.js";
import { countTokens } from "../agent/tokens.js";
import {
	ContextExceededError,
	isContextExceededMessage,
	isTransientMessage,
} from "./errors.js";
import { retryWithBackoff } from "./retry.js";

const DEADLINE_MS = Number(process.env.RUMMY_LLM_DEADLINE_MS);
const MAX_BACKOFF_MS = Number(process.env.RUMMY_LLM_MAX_BACKOFF_MS);
if (!DEADLINE_MS) throw new Error("RUMMY_LLM_DEADLINE_MS must be set");
if (!MAX_BACKOFF_MS) throw new Error("RUMMY_LLM_MAX_BACKOFF_MS must be set");

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

		// Cap output at 90% of remaining context (contextSize - input).
		// Without this, models plan responses larger than physics allows
		// and get truncated mid-thought. Explicit cap means the model
		// budgets its output coherently from the start. The 10% margin
		// covers response framing overhead and tokenizer drift.
		const contextSize = await this.getContextSize(model);
		const inputTokens = countTokens(JSON.stringify(messages));
		const remaining = contextSize - inputTokens;
		const maxTokens = remaining > 0 ? Math.floor(remaining * 0.9) : undefined;

		const resolvedOptions = { ...options, temperature, maxTokens };

		const provider = this.#selectProvider(resolvedModel);
		if (!provider) {
			throw new Error(
				`No LLM provider registered for model "${resolvedModel}". ` +
					`Check your RUMMY_* env vars or register a provider plugin.`,
			);
		}

		try {
			return await retryWithBackoff(
				() => provider.completion(messages, resolvedModel, resolvedOptions),
				{
					signal: options.signal,
					deadlineMs: DEADLINE_MS,
					maxDelayMs: MAX_BACKOFF_MS,
					isRetryable: (err) => isTransientMessage(err.message),
					onRetry: (err, attempt, delayMs, remainingMs) => {
						console.error(
							`[LLM] transient failure on ${provider.name} attempt ${attempt}: ${err.message}; retrying in ${delayMs}ms (${Math.round(remainingMs / 1000)}s deadline remaining)`,
						);
					},
				},
			);
		} catch (err) {
			if (isContextExceededMessage(err.message)) {
				throw new ContextExceededError(err.message, { cause: err });
			}
			throw err;
		}
	}

	async getContextSize(model) {
		const row = await this.#db.get_model_by_alias.get({ alias: model });
		if (row?.context_length) return row.context_length;

		const resolvedModel = await this.resolve(model);
		const provider = this.#selectProvider(resolvedModel);
		if (!provider) {
			throw new Error(
				`No LLM provider registered for model "${resolvedModel}".`,
			);
		}
		const size = await provider.getContextSize(resolvedModel);
		await this.#db.update_model_context_length.run({
			alias: model,
			context_length: size,
		});
		return size;
	}
}
