import msg from "../agent/messages.js";

const FETCH_TIMEOUT = Number(process.env.RUMMY_FETCH_TIMEOUT);
if (!FETCH_TIMEOUT) throw new Error("RUMMY_FETCH_TIMEOUT must be set");

export default class XaiClient {
	#baseUrl;
	#apiKey;
	#contextCache = new Map();

	constructor(baseUrl, apiKey) {
		this.#baseUrl = baseUrl;
		this.#apiKey = apiKey;
	}

	async completion(messages, model, options = {}) {
		if (!this.#apiKey) throw new Error(msg("error.xai_api_key_missing"));

		const body = { model, input: messages };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeout = FETCH_TIMEOUT;
		const timeoutSignal = AbortSignal.timeout(timeout);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;

		const response = await fetch(this.#baseUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			const error = await response.text();
			if (response.status === 401 || response.status === 403) {
				throw new Error(
					msg("error.xai_auth", {
						status: `${response.status} - ${error}`,
					}),
				);
			}
			throw new Error(
				msg("error.xai_api", {
					status: `${response.status} - ${error}`,
				}),
			);
		}

		const data = await response.json();
		return this.#normalize(data);
	}

	#normalize(data) {
		const output = data.output || [];

		let content = "";
		let reasoningContent = null;

		for (const item of output) {
			if (item.type === "reasoning") {
				const text = this.#extractText(item.content);
				if (text)
					reasoningContent = reasoningContent
						? `${reasoningContent}\n${text}`
						: text;
			}
			if (item.type === "message") {
				const text = this.#extractText(item.content);
				if (text) content = content ? `${content}\n${text}` : text;
			}
		}

		const usage = data.usage || {};
		const inputTokens = usage.input_tokens || 0;
		const outputTokens = usage.output_tokens || 0;
		return {
			choices: [
				{
					message: {
						role: "assistant",
						content,
						reasoning_content: reasoningContent,
					},
				},
			],
			usage: {
				prompt_tokens: inputTokens,
				cached_tokens: usage.input_tokens_details?.cached_tokens || 0,
				completion_tokens: outputTokens,
				reasoning_tokens: usage.output_tokens_details?.reasoning_tokens || 0,
				total_tokens: inputTokens + outputTokens,
				cost: (usage.cost_in_usd_ticks || 0) / 10_000_000_000,
			},
		};
	}

	#extractText(content) {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return null;
		return (
			content
				.filter((c) => c.type === "text" || c.type === "output_text")
				.map((c) => c.text)
				.join("\n") || null
		);
	}

	async getContextSize(model) {
		if (this.#contextCache.has(model)) return this.#contextCache.get(model);

		if (!this.#apiKey) throw new Error(msg("error.xai_api_key_missing"));

		// Query xAI models endpoint
		const modelsUrl = this.#baseUrl.replace(/\/responses$/, "/models");
		const res = await fetch(modelsUrl, {
			headers: { Authorization: `Bearer ${this.#apiKey}` },
			signal: AbortSignal.timeout(5000),
		});

		if (res.ok) {
			const data = await res.json();
			const models = data.data || data.models || [];
			const entry = models.find(
				(m) => m.id === model || `${m.id}-latest` === model,
			);
			if (entry?.context_length) {
				this.#contextCache.set(model, entry.context_length);
				return entry.context_length;
			}
		}

		// Try /v1/language-models for richer metadata
		const langUrl = this.#baseUrl.replace(
			/\/responses$/,
			`/language-models/${model}`,
		);
		const langRes = await fetch(langUrl, {
			headers: { Authorization: `Bearer ${this.#apiKey}` },
			signal: AbortSignal.timeout(5000),
		}).catch(() => null);

		if (langRes?.ok) {
			const langData = await langRes.json();
			if (langData?.context_length) {
				this.#contextCache.set(model, langData.context_length);
				return langData.context_length;
			}
		}

		throw new Error(
			`Cannot determine context size for xAI model "${model}". ` +
				"Register the model with addModel(contextLength) or set context_length in the models table.",
		);
	}
}
