import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemas = {
	ask: JSON.parse(
		readFileSync(join(__dirname, "../../domain/schema/ask.json"), "utf8"),
	),
	act: JSON.parse(
		readFileSync(join(__dirname, "../../domain/schema/act.json"), "utf8"),
	),
};

export default class OpenRouterClient {
	#apiKey;
	#baseUrl;
	#hooks;
	#capabilities;

	constructor(apiKey, hooks, capabilities) {
		this.#apiKey = apiKey;
		this.#hooks = hooks;
		this.#capabilities = capabilities;
		this.#baseUrl = process.env.OPENROUTER_BASE_URL;
	}

	async completion(messages, model, options = {}) {
		if (!this.#apiKey) {
			throw new Error(
				"OpenRouter API key is missing. Please set OPENROUTER_API_KEY in your environment.",
			);
		}

		// Strip prefill if present — structured outputs don't use it
		let finalMessages = messages;
		if (messages.at(-1)?.role === "assistant") {
			finalMessages = messages.slice(0, -1);
		}

		return this.#fetch(finalMessages, model, options);
	}

	async #fetch(messages, model, options) {
		const body = { model, messages };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const supportsStructured =
			this.#capabilities?.supports(model, "structured_outputs") ||
			this.#capabilities?.supports(model, "response_format") ||
			false;

		if (supportsStructured) {
			const schema = schemas[options.mode] || schemas.ask;
			body.response_format = {
				type: "json_schema",
				json_schema: {
					name: `rummy_${options.mode || "ask"}`,
					strict: true,
					schema,
				},
			};
		}

		const timeout = Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000;
		const response = await fetch(`${this.#baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": process.env.RUMMY_HTTP_REFERER,
				"X-Title": process.env.RUMMY_X_TITLE,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeout),
		});

		if (!response.ok) {
			const error = await response.text();
			if (response.status === 401 || response.status === 403) {
				throw new Error(
					`OpenRouter Authentication Error: ${response.status} - ${error}. Please check your OPENROUTER_API_KEY.`,
				);
			}
			throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
		}
		return response.json();
	}

	async getContextSize(model) {
		const timeout = Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000;
		const response = await fetch(`${this.#baseUrl}/models`, {
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
			},
			signal: AbortSignal.timeout(timeout),
		});
		if (!response.ok) return null;
		const data = await response.json();
		const found = data.data?.find((m) => m.id === model);
		if (found && this.#capabilities) {
			this.#capabilities.set(model, found);
		}
		return found?.context_length || null;
	}
}
