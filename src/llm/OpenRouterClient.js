import msg from "../agent/messages.js";

const DEFAULT_CONTEXT_SIZE = 131072;

export default class OpenRouterClient {
	#apiKey;
	#baseUrl;

	constructor(apiKey) {
		this.#apiKey = apiKey;
		this.#baseUrl = process.env.OPENROUTER_BASE_URL;
	}

	async completion(messages, model, options = {}) {
		if (!this.#apiKey) throw new Error(msg("error.openrouter_api_key_missing"));
		return this.#fetch(messages, model, options);
	}

	async #fetch(messages, model, options) {
		const body = { model, messages, include_reasoning: true };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeout = Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000;
		const timeoutSignal = AbortSignal.timeout(timeout);
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

		for (const choice of data.choices || []) {
			const cm = choice.message;
			if (!cm) continue;
			const parts = [
				cm.reasoning_content,
				cm.reasoning,
				cm.thinking,
				...(cm.reasoning_details || []).map((d) => d.text),
			].filter(Boolean);
			cm.reasoning_content =
				parts.length > 0 ? [...new Set(parts)].join("\n") : null;
		}

		return data;
	}

	async getContextSize(_model) {
		return Number(process.env.RUMMY_CONTEXT_SIZE) || DEFAULT_CONTEXT_SIZE;
	}
}
