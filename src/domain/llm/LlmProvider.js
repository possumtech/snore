import OllamaClient from "../../infrastructure/llm/OllamaClient.js";
import OpenRouterClient from "../../infrastructure/llm/OpenRouterClient.js";

/**
 * LlmProvider: Factory and router for multiple LLM backends.
 */
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

	/**
	 * Routes the request to the appropriate client based on model ID prefix.
	 * Default is OpenRouter.
	 */
	async completion(messages, model) {
		const resolvedModel = process.env[`RUMMY_MODEL_${model}`] || model;

		if (resolvedModel.startsWith("ollama/")) {
			const localModel = resolvedModel.replace("ollama/", "");
			return this.#ollama.completion(messages, localModel);
		}

		return this.#openRouter.completion(messages, resolvedModel);
	}
}
