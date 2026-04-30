import config from "../../agent/config.js";
import msg from "../../agent/messages.js";
import { chatCompletionStream } from "../../llm/openaiStream.js";
import { retryWithBackoff } from "../../llm/retry.js";

const { FETCH_TIMEOUT, THINK } = config;

const PROVIDER = "ollama";

// Inert unless OLLAMA_BASE_URL is set; ollama/{model[/registry]} aliases.
export default class Ollama {
	#baseUrl;

	constructor(core) {
		const baseUrl = process.env.OLLAMA_BASE_URL;
		if (!baseUrl) return;
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
		const body = { model, messages, think: THINK };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;

		try {
			return await chatCompletionStream({
				url: `${this.#baseUrl}/v1/chat/completions`,
				headers: {},
				body,
				signal,
			});
		} catch (err) {
			if (err.status) {
				throw new Error(
					msg("error.ollama_api", { status: `${err.status} - ${err.body}` }),
				);
			}
			throw err;
		}
	}

	async #getContextSize(model) {
		const fetchContext = async () => {
			const response = await fetch(`${this.#baseUrl}/api/show`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model }),
				signal: AbortSignal.timeout(FETCH_TIMEOUT),
			});
			if (!response.ok) {
				throw new Error(
					msg("error.ollama_show_failed", {
						status: response.status,
						baseUrl: this.#baseUrl,
					}),
				);
			}
			const data = await response.json();
			if (data.model_info) {
				for (const [key, value] of Object.entries(data.model_info)) {
					if (key.endsWith(".context_length")) return value;
				}
			}
			throw new Error(msg("error.ollama_no_context_length", { model }));
		};
		try {
			return await retryWithBackoff(fetchContext, {
				deadlineMs: FETCH_TIMEOUT,
				isRetryable: (err) => !err.message.includes("Ollama"),
			});
		} catch (err) {
			if (err.message.includes("Ollama")) throw err;
			throw new Error(
				msg("error.ollama_unreachable", { baseUrl: this.#baseUrl }),
				{ cause: err },
			);
		}
	}
}
