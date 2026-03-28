import ModelCapabilities from "../../infrastructure/llm/ModelCapabilities.js";
import OllamaClient from "../../infrastructure/llm/OllamaClient.js";
import OpenAiClient from "../../infrastructure/llm/OpenAiClient.js";
import OpenRouterClient from "../../infrastructure/llm/OpenRouterClient.js";

export default class LlmProvider {
	#openRouter;
	#ollama;
	#openAi;
	#capabilities;

	constructor(hooks) {
		this.#capabilities = new ModelCapabilities();
		this.#openRouter = new OpenRouterClient(
			process.env.OPENROUTER_API_KEY,
			hooks,
			this.#capabilities,
		);

		this.#ollama = new OllamaClient(process.env.OLLAMA_BASE_URL, hooks);
		this.#openAi = new OpenAiClient(
			process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE,
			process.env.OPENAI_API_KEY,
		);
	}

	get capabilities() {
		return this.#capabilities;
	}

	static resolve(alias) {
		const actual = process.env[`RUMMY_MODEL_${alias}`];
		if (!actual) throw new Error(`Unknown model alias '${alias}'. Define RUMMY_MODEL_${alias} in your environment.`);
		return actual;
	}

	async completion(messages, model, options = {}) {
		const resolvedModel = LlmProvider.resolve(model);

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

		if (resolvedModel.startsWith("openai/")) {
			const localModel = resolvedModel.replace("openai/", "");
			return this.#openAi.completion(messages, localModel, resolvedOptions);
		}

		return this.#openRouter.completion(
			messages,
			resolvedModel,
			resolvedOptions,
		);
	}

	async getContextSize(model) {
		const resolvedModel = LlmProvider.resolve(model);
		if (resolvedModel.startsWith("ollama/")) {
			const localModel = resolvedModel.replace("ollama/", "");
			return this.#ollama.getContextSize(localModel);
		}
		if (resolvedModel.startsWith("openai/")) {
			return this.#openAi.getContextSize(resolvedModel);
		}
		return this.#openRouter.getContextSize(resolvedModel);
	}
}
