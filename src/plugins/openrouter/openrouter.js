import config from "../../agent/config.js";
import msg from "../../agent/messages.js";
import { chatCompletionStream } from "../../llm/openaiStream.js";

const { FETCH_TIMEOUT } = config;

const PROVIDER = "openrouter";

// Inert unless OPENROUTER_API_KEY+OPENROUTER_BASE_URL set; openrouter/{publisher}/{model} aliases.
export default class OpenRouter {
	#apiKey;
	#baseUrl;
	#contextCache = new Map();

	constructor(core) {
		const apiKey = process.env.OPENROUTER_API_KEY;
		const baseUrl = process.env.OPENROUTER_BASE_URL;
		if (!apiKey || !baseUrl) return;
		this.#apiKey = apiKey;
		this.#baseUrl = baseUrl;

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
		// include_reasoning is OpenRouter's relay-level knob: does the proxy
		// surface reasoning back to us? Always on — we pay for the tokens,
		// we keep the telemetry. Orthogonal to RUMMY_THINK (model-side).
		const body = { model, messages, include_reasoning: true };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;

		const headers = {
			Authorization: `Bearer ${this.#apiKey}`,
			"HTTP-Referer": process.env.RUMMY_HTTP_REFERER,
			"X-Title": process.env.RUMMY_X_TITLE,
		};

		try {
			return await chatCompletionStream({
				url: `${this.#baseUrl}/chat/completions`,
				headers,
				body,
				signal,
			});
		} catch (err) {
			if (err.status === 401 || err.status === 403) {
				throw new Error(
					msg("error.openrouter_auth", {
						status: `${err.status} - ${err.body}`,
					}),
				);
			}
			if (err.status) {
				throw new Error(
					msg("error.openrouter_api", {
						status: `${err.status} - ${err.body}`,
					}),
				);
			}
			throw err;
		}
	}

	async #getContextSize(model) {
		if (this.#contextCache.has(model)) return this.#contextCache.get(model);

		const res = await fetch(`${this.#baseUrl}/models`, {
			headers: { Authorization: `Bearer ${this.#apiKey}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT),
		});
		if (!res.ok) {
			throw new Error(
				`OpenRouter /models returned ${res.status}; cannot resolve context size for "${model}".`,
			);
		}
		const data = await res.json();
		const entry = data.data?.find((m) => m.id === model);
		if (!entry?.context_length) {
			throw new Error(
				`OpenRouter /models has no context_length for "${model}".`,
			);
		}
		this.#contextCache.set(model, entry.context_length);
		return entry.context_length;
	}
}
