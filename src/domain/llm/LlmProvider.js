import OllamaClient from "../../infrastructure/llm/OllamaClient.js";
import OpenRouterClient from "../../infrastructure/llm/OpenRouterClient.js";

export default class LlmProvider {
	#openRouter;
	#ollama;

	constructor(hooks) {
		this.#openRouter = new OpenRouterClient(
			process.env.OPENROUTER_API_KEY,
			hooks,
		);

		const ollamaUrl = process.env.OLLAMA_BASE_URL;
		this.#ollama = new OllamaClient(ollamaUrl, hooks);
	}

	async completion(messages, model, options = {}) {
		const resolvedModel = process.env[`RUMMY_MODEL_${model}`] || model;
		console.log(
			`[LlmProvider DEBUG] Resolving model '${model}' -> '${resolvedModel}'`,
		);

		// Resolve temperature: per-request > env default
		const temperature =
			options.temperature ??
			(process.env.RUMMY_TEMPERATURE !== undefined
				? Number.parseFloat(process.env.RUMMY_TEMPERATURE)
				: undefined);
		const resolvedOptions = { ...options, temperature };

		if (resolvedModel.startsWith("ollama/")) {
			const localModel = resolvedModel.replace("ollama/", "");
			return this.#ollama.completion(messages, localModel, resolvedOptions);
		}

		return this.#openRouter.completion(
			messages,
			resolvedModel,
			resolvedOptions,
		);
	}
}
