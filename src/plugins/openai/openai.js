import msg from "../../agent/messages.js";
import { chatCompletionStream } from "../../llm/openaiStream.js";

const FETCH_TIMEOUT = Number(process.env.RUMMY_FETCH_TIMEOUT);
const THINK = process.env.RUMMY_THINK === "1";

const PROVIDER = "openai";

// Inert unless OPENAI_BASE_URL is set; openai/{model} aliases.
export default class OpenAi {
	#baseUrl;
	#apiKey;

	constructor(core) {
		const baseUrl = process.env.OPENAI_BASE_URL;
		if (!baseUrl) return;
		this.#baseUrl = String(baseUrl).replace(/\/v1\/?$/, "");
		this.#apiKey = process.env.OPENAI_API_KEY;

		const wireModel = (alias) => alias.split("/").slice(1).join("/");

		core.hooks.llm.providers.push({
			name: PROVIDER,
			matches: (model) => model.split("/")[0] === PROVIDER,
			completion: (messages, model, options) =>
				this.#completion(messages, wireModel(model), options),
			getContextSize: (model) => this.#getContextSize(wireModel(model)),
		});
	}

	async #completion(messages, model, options = {}) {
		const body = { model, messages, think: THINK };
		if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;

		const headers = {};
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

		try {
			return await chatCompletionStream({
				url: `${this.#baseUrl}/v1/chat/completions`,
				headers,
				body,
				signal,
			});
		} catch (err) {
			if (err.status) {
				const wrapped = new Error(
					msg("error.openai_api", { status: `${err.status} - ${err.body}` }),
					{ cause: err },
				);
				wrapped.status = err.status;
				wrapped.body = err.body;
				wrapped.retryAfter = err.retryAfter;
				throw wrapped;
			}
			throw err;
		}
	}

	async #getContextSize(_model) {
		const headers = { "Content-Type": "application/json" };
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

		// llama.cpp /props returns runtime n_ctx; absent on vanilla OpenAI.
		try {
			const propsResponse = await fetch(`${this.#baseUrl}/props`, {
				headers,
				signal: AbortSignal.timeout(FETCH_TIMEOUT),
			});
			if (propsResponse.ok) {
				const props = await propsResponse.json();
				const runtimeCtx = props?.default_generation_settings?.n_ctx;
				if (runtimeCtx) return runtimeCtx;
			}
		} catch (_err) {}

		// Fall back to /v1/models for training context.
		const response = await fetch(`${this.#baseUrl}/v1/models`, {
			headers,
			signal: AbortSignal.timeout(FETCH_TIMEOUT),
		});
		if (!response.ok) {
			throw new Error(
				msg("error.openai_models_failed", {
					status: response.status,
					baseUrl: this.#baseUrl,
				}),
			);
		}
		const data = await response.json();
		const model = data.data?.[0];
		const ctx = model?.meta?.n_ctx_train || model?.context_length;
		if (!ctx) throw new Error(msg("error.openai_no_context_length"));
		return ctx;
	}
}
