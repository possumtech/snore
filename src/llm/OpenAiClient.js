import msg from "../agent/messages.js";

export default class OpenAiClient {
	#baseUrl;
	#apiKey;

	constructor(baseUrl, apiKey) {
		this.#baseUrl = String(baseUrl || "").replace(/\/v1\/?$/, "");
		this.#apiKey = apiKey || "";
	}

	async completion(messages, model, options = {}) {
		const body = { model, messages };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeout = Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000;
		const headers = { "Content-Type": "application/json" };
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

		const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeout),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(
				msg("error.openai_api", { status: `${response.status} - ${error}` }),
			);
		}

		const data = await response.json();

		for (const choice of data.choices || []) {
			const msg = choice.message;
			if (!msg) continue;

			// Normalize reasoning
			const parts = [msg.reasoning_content, msg.reasoning, msg.thinking].filter(
				Boolean,
			);
			msg.reasoning_content =
				parts.length > 0 ? [...new Set(parts)].join("\n") : null;
		}

		return data;
	}

	async getContextSize(_model) {
		const timeout = Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000;
		const headers = { "Content-Type": "application/json" };
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

		const response = await fetch(`${this.#baseUrl}/v1/models`, {
			headers,
			signal: AbortSignal.timeout(timeout),
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
