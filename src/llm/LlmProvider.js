import msg from "../agent/messages.js";
import OllamaClient from "./OllamaClient.js";
import OpenAiClient from "./OpenAiClient.js";
import OpenRouterClient from "./OpenRouterClient.js";
import XaiClient from "./XaiClient.js";

export default class LlmProvider {
	#db;
	#openRouter;
	#ollama;
	#openAi;
	#xai;

	constructor(db) {
		this.#db = db;
	}

	#getOpenRouter() {
		this.#openRouter ??= new OpenRouterClient(process.env.OPENROUTER_API_KEY);
		return this.#openRouter;
	}

	#getOllama() {
		this.#ollama ??= new OllamaClient(process.env.OLLAMA_BASE_URL);
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

	#getXai() {
		if (!this.#xai) {
			const baseUrl = process.env.XAI_BASE_URL;
			if (!baseUrl) throw new Error(msg("error.xai_base_url_missing"));
			this.#xai = new XaiClient(baseUrl, process.env.XAI_API_KEY);
		}
		return this.#xai;
	}

	async resolve(alias) {
		const row = await this.#db.get_model_by_alias.get({ alias });
		if (row) return row.actual;
		// Fallback to env for transition period
		const envActual = process.env[`RUMMY_MODEL_${alias}`];
		if (envActual) return envActual;
		throw new Error(msg("error.model_alias_unknown", { alias }));
	}

	async completion(messages, model, options = {}) {
		const resolvedModel = await this.resolve(model);

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

		if (resolvedModel.startsWith("x.ai/")) {
			const localModel = resolvedModel.replace("x.ai/", "");
			return this.#getXai().completion(
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
		const resolvedModel = await this.resolve(model);
		if (resolvedModel.startsWith("ollama/")) {
			const localModel = resolvedModel.replace("ollama/", "");
			return this.#getOllama().getContextSize(localModel);
		}
		if (resolvedModel.startsWith("openai/")) {
			return this.#getOpenAi().getContextSize(resolvedModel);
		}
		if (resolvedModel.startsWith("x.ai/")) {
			const localModel = resolvedModel.replace("x.ai/", "");
			return this.#getXai().getContextSize(localModel);
		}
		return this.#getOpenRouter().getContextSize(resolvedModel);
	}
}
