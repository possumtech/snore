import msg from "../../agent/messages.js";

const FETCH_TIMEOUT = Number(process.env.RUMMY_FETCH_TIMEOUT);
if (!FETCH_TIMEOUT) throw new Error("RUMMY_FETCH_TIMEOUT must be set");

const PROVIDER = "ollama";

/**
 * Ollama LLM provider plugin. Registers with hooks.llm.providers if
 * OLLAMA_BASE_URL is set; inert otherwise. Handles model aliases of the
 * form `ollama/{modelName}` — e.g. `ollama/llama3.1:8b` or
 * `ollama/library/qwen:7b` (Ollama accepts both bare and
 * registry-qualified model names).
 */
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
		const body = { model, messages, think: true };
		if (options.temperature !== undefined) body.temperature = options.temperature;

		const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
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
			const m = choice.message;
			if (!m) continue;
			const parts = [m.reasoning_content, m.reasoning, m.thinking].filter(
				Boolean,
			);
			m.reasoning_content =
				parts.length > 0 ? [...new Set(parts)].join("\n") : null;
		}

		return data;
	}

	async #getContextSize(model) {
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
