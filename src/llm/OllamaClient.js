import msg from "../agent/messages.js";

const FETCH_TIMEOUT = Number(process.env.RUMMY_FETCH_TIMEOUT);
if (!FETCH_TIMEOUT) throw new Error("RUMMY_FETCH_TIMEOUT must be set");

export default class OllamaClient {
	#baseUrl;

	constructor(baseUrl) {
		if (!baseUrl) {
			throw new Error(
				"OLLAMA_BASE_URL must be set to use ollama/* models. Example: OLLAMA_BASE_URL=http://127.0.0.1:11434",
			);
		}
		this.#baseUrl = baseUrl;
	}

	async completion(messages, model, options = {}) {
		const body = { model, messages, think: true };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeout = FETCH_TIMEOUT;
		const timeoutSignal = AbortSignal.timeout(timeout);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;

		const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(
				msg("error.ollama_api", { status: `${response.status} - ${error}` }),
			);
		}

		const data = await response.json();

		for (const choice of data.choices || []) {
			const msg = choice.message;
			if (!msg) continue;
			const parts = [msg.reasoning_content, msg.reasoning, msg.thinking].filter(
				Boolean,
			);
			msg.reasoning_content =
				parts.length > 0 ? [...new Set(parts)].join("\n") : null;
		}

		return data;
	}

	async getContextSize(model) {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
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
				const info = data.model_info || {};
				for (const [key, value] of Object.entries(info)) {
					if (key.endsWith(".context_length")) return value;
				}
				throw new Error(msg("error.ollama_no_context_length", { model }));
			} catch (err) {
				if (err.message.includes("Ollama")) throw err;
				if (attempt < 2) {
					await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
					continue;
				}
				throw new Error(
					msg("error.ollama_unreachable", { baseUrl: this.#baseUrl }),
					{ cause: err },
				);
			}
		}
	}
}
