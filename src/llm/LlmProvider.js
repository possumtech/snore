import msg from "../agent/messages.js";
import {
	ContextExceededError,
	isContextExceededMessage,
	isTransientMessage,
} from "./errors.js";
import OllamaClient from "./OllamaClient.js";
import OpenAiClient from "./OpenAiClient.js";
import OpenRouterClient from "./OpenRouterClient.js";
import XaiClient from "./XaiClient.js";

const MAX_TRANSIENT_RETRIES = 3;

export default class LlmProvider {
	#db;
	#openRouter;
	#ollama;
	#openAi;
	#xai;

	constructor(db) {
		this.#db = db;
	}

	#getOpenRouter() {
		this.#openRouter ??= new OpenRouterClient(process.env.OPENROUTER_API_KEY);
		return this.#openRouter;
	}

	#getOllama() {
		this.#ollama ??= new OllamaClient(process.env.OLLAMA_BASE_URL);
		return this.#ollama;
	}

	#getOpenAi() {
		if (!this.#openAi) {
			const baseUrl = process.env.OPENAI_BASE_URL;
			if (!baseUrl) throw new Error(msg("error.openai_base_url_missing"));
			this.#openAi = new OpenAiClient(baseUrl, process.env.OPENAI_API_KEY);
		}
		return this.#openAi;
	}

	#getXai() {
		if (!this.#xai) {
			const baseUrl = process.env.XAI_BASE_URL;
			if (!baseUrl) throw new Error(msg("error.xai_base_url_missing"));
			this.#xai = new XaiClient(baseUrl, process.env.XAI_API_KEY);
		}
		return this.#xai;
	}

	async resolve(alias) {
		const row = await this.#db.get_model_by_alias.get({ alias });
		if (row) return row.actual;
		throw new Error(msg("error.model_alias_unknown", { alias }));
	}

	/**
	 * Wraps per-vendor completion with transient-error retry (503/429/
	 * timeout/ECONNREFUSED/ECONNRESET/unavailable — exponential backoff,
	 * up to MAX_TRANSIENT_RETRIES) and context-exceeded detection.
	 *
	 * On context exceeded the vendor's Error is re-raised as a typed
	 * ContextExceededError so callers can branch on the error class
	 * instead of regex-matching message strings.
	 */
	async completion(messages, model, options = {}) {
		const resolvedModel = await this.resolve(model);

		const temperature =
			options.temperature ??
			(process.env.RUMMY_TEMPERATURE !== undefined
				? Number.parseFloat(process.env.RUMMY_TEMPERATURE)
				: undefined);
		const resolvedOptions = { ...options, temperature };

		for (let attempt = 0; ; attempt++) {
			try {
				return await this.#dispatch(resolvedModel, messages, resolvedOptions);
			} catch (err) {
				if (isContextExceededMessage(err.message)) {
					throw new ContextExceededError(err.message, { cause: err });
				}
				if (isTransientMessage(err.message) && attempt < MAX_TRANSIENT_RETRIES) {
					const delay = 1000 * 2 ** attempt;
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}
				throw err;
			}
		}
	}

	async #dispatch(resolvedModel, messages, resolvedOptions) {
		if (resolvedModel.startsWith("ollama/")) {
			const localModel = resolvedModel.replace("ollama/", "");
			return this.#getOllama().completion(
				messages,
				localModel,
				resolvedOptions,
			);
		}

		if (resolvedModel.startsWith("openai/")) {
			const localModel = resolvedModel.replace("openai/", "");
			return this.#getOpenAi().completion(
				messages,
				localModel,
				resolvedOptions,
			);
		}

		if (resolvedModel.startsWith("x.ai/")) {
			const localModel = resolvedModel.replace("x.ai/", "");
			return this.#getXai().completion(messages, localModel, resolvedOptions);
		}

		return this.#getOpenRouter().completion(
			messages,
			resolvedModel,
			resolvedOptions,
		);
	}

	async getContextSize(model) {
		// DB is the authority — check models table first
		if (this.#db) {
			const row = await this.#db.get_model_by_alias.get({ alias: model });
			if (row?.context_length) return row.context_length;
		}

		// Fall back to API query
		const resolvedModel = await this.resolve(model);
		let size;
		if (resolvedModel.startsWith("ollama/")) {
			const localModel = resolvedModel.replace("ollama/", "");
			size = await this.#getOllama().getContextSize(localModel);
		} else if (resolvedModel.startsWith("openai/")) {
			size = await this.#getOpenAi().getContextSize(resolvedModel);
		} else if (resolvedModel.startsWith("x.ai/")) {
			const localModel = resolvedModel.replace("x.ai/", "");
			size = await this.#getXai().getContextSize(localModel);
		} else {
			size = await this.#getOpenRouter().getContextSize(resolvedModel);
		}

		// Cache back to DB for next time
		if (this.#db && size) {
			await this.#db.update_model_context_length
				.run({
					alias: model,
					context_length: size,
				})
				.catch(() => {});
		}

		return size;
	}
}
