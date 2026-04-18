import msg from "../../agent/messages.js";

const FETCH_TIMEOUT = Number(process.env.RUMMY_FETCH_TIMEOUT);
if (!FETCH_TIMEOUT) throw new Error("RUMMY_FETCH_TIMEOUT must be set");

const PREFIX = "openai/";

/**
 * OpenAI-compatible LLM provider plugin. Registers with hooks.llm.providers
 * if OPENAI_BASE_URL is set in env; silently inert otherwise. Handles any
 * model alias prefixed with "openai/".
 *
 * Strips the "openai/" prefix before making the HTTP call. Normalizes
 * reasoning fields into `message.reasoning_content`.
 */
export default class OpenAi {
	#baseUrl;
	#apiKey;

	constructor(core) {
		const baseUrl = process.env.OPENAI_BASE_URL;
		if (!baseUrl) return;
		this.#baseUrl = String(baseUrl).replace(/\/v1\/?$/, "");
		this.#apiKey = process.env.OPENAI_API_KEY || "";

		core.hooks.llm.providers.push({
			name: "openai",
			matches: (model) => model.startsWith(PREFIX),
			completion: (messages, model, options) =>
				this.#completion(messages, model.slice(PREFIX.length), options),
			getContextSize: (model) =>
				this.#getContextSize(model.slice(PREFIX.length)),
		});
	}

	async #completion(messages, model, options = {}) {
		const body = { model, messages, think: true };
		if (options.temperature !== undefined) body.temperature = options.temperature;

		const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;

		const headers = { "Content-Type": "application/json" };
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

		const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(
				msg("error.openai_api", { status: `${response.status} - ${error}` }),
			);
		}

		const data = await response.json();

		for (const choice of data.choices || []) {
			const m = choice.message;
			if (!m) continue;
			const parts = [m.reasoning_content, m.reasoning, m.thinking].filter(
				Boolean,
			);
			m.reasoning_content =
				parts.length > 0 ? [...new Set(parts)].join("\n") : null;

			if (process.env.RUMMY_DEBUG === "true" && m.reasoning_content) {
				console.warn(
					`[RUMMY] Reasoning (${m.reasoning_content.length} chars): ${m.reasoning_content.slice(0, 120)}`,
				);
			}
		}

		return data;
	}

	async #getContextSize(_model) {
		const headers = { "Content-Type": "application/json" };
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

		// Try /props first — llama.cpp exposes runtime n_ctx here.
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
		} catch {}

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
