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

export default class OllamaClient {
	#baseUrl;
	#hooks;

	constructor(baseUrl, hooks) {
		this.#baseUrl = baseUrl;
		this.#hooks = hooks;
	}

	async completion(messages, model, options = {}) {
		// Strip prefill if present — structured outputs don't use it
		let finalMessages = messages;
		if (messages.at(-1)?.role === "assistant") {
			finalMessages = messages.slice(0, -1);
		}

		const schema = schemas[options.mode] || schemas.ask;
		const body = {
			model,
			messages: finalMessages,
			think: true,
			format: schema,
		};
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeout = Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000;
		const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeout),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Ollama API error: ${response.status} - ${error}`);
		}

		const data = await response.json();

		// Ollama uses "reasoning" field; normalize to "reasoning_content" (OpenAI standard)
		for (const choice of data.choices || []) {
			if (choice.message?.reasoning && !choice.message.reasoning_content) {
				choice.message.reasoning_content = choice.message.reasoning;
			}
		}

		return data;
	}

	async getContextSize(model) {
		// Ollama lazy-loads models — first request can be slow.
		// Retry up to 3 times with increasing delays.
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const response = await fetch(`${this.#baseUrl}/api/show`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model }),
					signal: AbortSignal.timeout(
						Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000,
					),
				});
				if (!response.ok) {
					throw new Error(`Ollama /api/show failed: ${response.status}. Is Ollama running at ${this.#baseUrl}?`);
				}
				const data = await response.json();
				const info = data.model_info || {};
				for (const [key, value] of Object.entries(info)) {
					if (key.endsWith(".context_length")) return value;
				}
				throw new Error(`Ollama /api/show returned no context_length for model '${model}'.`);
			} catch (err) {
				if (err.message.includes("Ollama")) throw err;
				if (attempt < 2) {
					await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
					continue;
				}
				throw new Error(`Ollama /api/show unreachable after 3 attempts. Is Ollama running at ${this.#baseUrl}?`, { cause: err });
			}
		}
	}
}
