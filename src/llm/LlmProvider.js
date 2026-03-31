import msg from "../agent/messages.js";
import ModelCapabilities from "./ModelCapabilities.js";
import OllamaClient from "./OllamaClient.js";
import OpenAiClient from "./OpenAiClient.js";
import OpenRouterClient from "./OpenRouterClient.js";

export default class LlmProvider {
	#openRouter;
	#ollama;
	#openAi;
	#capabilities;
	#hooks;
	#db;

	constructor(hooks, db) {
		this.#hooks = hooks;
		this.#db = db;
		this.#capabilities = new ModelCapabilities();
	}

	#getOpenRouter() {
		this.#openRouter ??= new OpenRouterClient(
			process.env.OPENROUTER_API_KEY,
			this.#hooks,
			this.#capabilities,
			this.#db,
		);
		return this.#openRouter;
	}

	#getOllama() {
		this.#ollama ??= new OllamaClient(process.env.OLLAMA_BASE_URL, this.#hooks);
		return this.#ollama;
	}

	#getOpenAi() {
		if (!this.#openAi) {
			const baseUrl =
				process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE;
			if (!baseUrl) throw new Error(msg("error.openai_base_url_missing"));
			this.#openAi = new OpenAiClient(baseUrl, process.env.OPENAI_API_KEY);
		}
		return this.#openAi;
	}

	get capabilities() {
		return this.#capabilities;
	}

	static resolve(alias) {
		const actual = process.env[`RUMMY_MODEL_${alias}`];
		if (!actual) throw new Error(msg("error.model_alias_unknown", { alias }));
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
			return this.#getOllama().completion(
				messages,
				localModel,
				resolvedOptions,
			);
		}

		if (resolvedModel.startsWith("openai/")) {
			const localModel = resolvedModel.replace("openai/", "");
			return this.#getOpenAi().completion(
				messages,
				localModel,
				resolvedOptions,
			);
		}

		return this.#getOpenRouter().completion(
			messages,
			resolvedModel,
			resolvedOptions,
		);
	}

	async getContextSize(model) {
		const resolvedModel = LlmProvider.resolve(model);
		if (resolvedModel.startsWith("ollama/")) {
			const localModel = resolvedModel.replace("ollama/", "");
			return this.#getOllama().getContextSize(localModel);
		}
		if (resolvedModel.startsWith("openai/")) {
			return this.#getOpenAi().getContextSize(resolvedModel);
		}
		return this.#getOpenRouter().getContextSize(resolvedModel);
	}
}
