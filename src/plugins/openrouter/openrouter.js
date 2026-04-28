import msg from "../../agent/messages.js";

const FETCH_TIMEOUT = Number(process.env.RUMMY_FETCH_TIMEOUT);
if (!FETCH_TIMEOUT) throw new Error("RUMMY_FETCH_TIMEOUT must be set");

const PROVIDER = "openrouter";

/**
 * OpenRouter LLM provider plugin. Handles model aliases of the form
 * `openrouter/{publisher}/{modelName}`. Strips only the provider
 * segment — OpenRouter's own API expects the `publisher/model` form,
 * so that's exactly what's passed through to it (e.g.
 * `openrouter/anthropic/claude-3-opus` → API receives
 * `anthropic/claude-3-opus`).
 *
 * Inert if OPENROUTER_API_KEY / OPENROUTER_BASE_URL aren't set.
 */
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
		const body = { model, messages, include_reasoning: true };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;

		const response = await fetch(`${this.#baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": process.env.RUMMY_HTTP_REFERER,
				"X-Title": process.env.RUMMY_X_TITLE,
			},
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			const error = await response.text();
			if (response.status === 401 || response.status === 403) {
				throw new Error(
					msg("error.openrouter_auth", {
						status: `${response.status} - ${error}`,
					}),
				);
			}
			throw new Error(
				msg("error.openrouter_api", {
					status: `${response.status} - ${error}`,
				}),
			);
		}
		const data = await response.json();

		for (const choice of data.choices) {
			const cm = choice.message;
			if (!cm) continue;
			const details = cm.reasoning_details
				? cm.reasoning_details.map((d) => d.text)
				: [];
			const parts = [
				cm.reasoning_content,
				cm.reasoning,
				cm.thinking,
				...details,
			].filter(Boolean);
			cm.reasoning_content =
				parts.length > 0 ? [...new Set(parts)].join("\n") : null;
		}

		return data;
	}

	async #getContextSize(model) {
		if (this.#contextCache.has(model)) return this.#contextCache.get(model);

		const res = await fetch(`${this.#baseUrl}/models`, {
			headers: { Authorization: `Bearer ${this.#apiKey}` },
			signal: AbortSignal.timeout(5000),
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
