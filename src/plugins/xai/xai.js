import config from "../../agent/config.js";
import msg from "../../agent/messages.js";

const { FETCH_TIMEOUT } = config;

const PROVIDER = "xai";

// Inert unless XAI_BASE_URL set; xai/{model} aliases; normalizes to OpenAI envelope.
export default class Xai {
	#baseUrl;
	#apiKey;
	#contextCache = new Map();

	constructor(core) {
		const baseUrl = process.env.XAI_BASE_URL;
		if (!baseUrl) return;
		this.#baseUrl = baseUrl;
		this.#apiKey = process.env.XAI_API_KEY;

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
		if (!this.#apiKey) throw new Error(msg("error.xai_api_key_missing"));

		const body = { model, input: messages };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
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
					msg("error.xai_auth", { status: `${response.status} - ${error}` }),
				);
			}
			throw new Error(
				msg("error.xai_api", { status: `${response.status} - ${error}` }),
			);
		}

		return this.#normalize(await response.json());
	}

	#normalize(data) {
		let content = "";
		let reasoningContent = null;

		for (const item of data.output) {
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

		const { usage } = data;
		const inputTokens = usage.input_tokens;
		const outputTokens = usage.output_tokens;
		// Optional per xAI API; absent on providers that don't surface them.
		const cached = usage.input_tokens_details?.cached_tokens;
		const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
		const costTicks = usage.cost_in_usd_ticks;
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
				cached_tokens: cached === undefined ? 0 : cached,
				completion_tokens: outputTokens,
				reasoning_tokens: reasoningTokens === undefined ? 0 : reasoningTokens,
				total_tokens: inputTokens + outputTokens,
				cost: costTicks === undefined ? 0 : costTicks / 10_000_000_000,
			},
		};
	}

	#extractText(content) {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return null;
		const joined = content
			.filter((c) => c.type === "text" || c.type === "output_text")
			.map((c) => c.text)
			.join("\n");
		return joined ? joined : null;
	}

	async #getContextSize(model) {
		if (this.#contextCache.has(model)) return this.#contextCache.get(model);
		if (!this.#apiKey) throw new Error(msg("error.xai_api_key_missing"));

		const modelsUrl = this.#baseUrl.replace(/\/responses$/, "/models");
		const res = await fetch(modelsUrl, {
			headers: { Authorization: `Bearer ${this.#apiKey}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT),
		});
		if (res.ok) {
			const data = await res.json();
			// xAI /models response shape varies by API version.
			let models;
			if (data.data) models = data.data;
			else if (data.models) models = data.models;
			else throw new Error("xAI /models response has neither data nor models");
			const entry = models.find(
				(m) => m.id === model || `${m.id}-latest` === model,
			);
			if (entry?.context_length) {
				this.#contextCache.set(model, entry.context_length);
				return entry.context_length;
			}
		}

		const langUrl = this.#baseUrl.replace(
			/\/responses$/,
			`/language-models/${model}`,
		);
		// Optional probe; failure falls through to terminal throw below.
		const langRes = await fetch(langUrl, {
			headers: { Authorization: `Bearer ${this.#apiKey}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT),
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
