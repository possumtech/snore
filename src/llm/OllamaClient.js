import ToolSchema from "../schema/ToolSchema.js";

export default class OllamaClient {
	#baseUrl;
	#hooks;

	constructor(baseUrl, hooks) {
		this.#baseUrl = baseUrl;
		this.#hooks = hooks;
	}

	async completion(messages, model, options = {}) {
		const tools = options.mode === "act" ? ToolSchema.actApi : ToolSchema.askApi;

		const body = {
			model,
			messages,
			tools,
			think: true,
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

		for (const choice of data.choices || []) {
			const msg = choice.message;
			if (!msg) continue;
			const parts = [msg.reasoning_content, msg.reasoning, msg.thinking].filter(
				Boolean,
			);
			msg.reasoning_content =
				parts.length > 0 ? [...new Set(parts)].join("\n") : null;

			// Normalize tool_calls arguments (Ollama returns parsed objects)
			for (const tc of msg.tool_calls || []) {
				if (tc.function && typeof tc.function.arguments !== "string") {
					tc.function.arguments = JSON.stringify(tc.function.arguments);
				}
			}
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
					signal: AbortSignal.timeout(
						Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000,
					),
				});
				if (!response.ok) {
					throw new Error(
						`Ollama /api/show failed: ${response.status}. Is Ollama running at ${this.#baseUrl}?`,
					);
				}
				const data = await response.json();
				const info = data.model_info || {};
				for (const [key, value] of Object.entries(info)) {
					if (key.endsWith(".context_length")) return value;
				}
				throw new Error(
					`Ollama /api/show returned no context_length for model '${model}'.`,
				);
			} catch (err) {
				if (err.message.includes("Ollama")) throw err;
				if (attempt < 2) {
					await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
					continue;
				}
				throw new Error(
					`Ollama /api/show unreachable after 3 attempts. Is Ollama running at ${this.#baseUrl}?`,
					{ cause: err },
				);
			}
		}
	}
}
