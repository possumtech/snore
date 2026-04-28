import config from "../agent/config.js";
import msg from "../agent/messages.js";
import {
	ContextExceededError,
	isContextExceededMessage,
	isTransientMessage,
} from "./errors.js";
import { retryWithBackoff } from "./retry.js";

const { LLM_DEADLINE, LLM_MAX_BACKOFF } = config;

// Dispatches to hooks.llm.providers; transient retry; ContextExceededError surface.
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

		try {
			return await retryWithBackoff(
				() => provider.completion(messages, resolvedModel, resolvedOptions),
				{
					signal: options.signal,
					deadlineMs: LLM_DEADLINE,
					maxDelayMs: LLM_MAX_BACKOFF,
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
