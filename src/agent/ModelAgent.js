export default class ModelAgent {
	#db;
	#hooks;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
	}

	/**
	 * Returns combined list of DB models and SNORE_MODEL_ environment aliases.
	 */
	async getModels() {
		const dbModels = await this.#db.get_models.all();

		const envModels = Object.keys(process.env)
			.filter((key) => key.startsWith("SNORE_MODEL_"))
			.map((key) => {
				const alias = key.replace("SNORE_MODEL_", "");
				return {
					id: alias,
					name: alias,
					description: `Alias for ${process.env[key]}`,
					target: process.env[key],
				};
			});

		const result = [...dbModels, ...envModels];
		return await this.#hooks.rpc.response.result.filter(result, {
			method: "getModels",
		});
	}

	/**
	 * Fetches the full list of models from OpenRouter for client-side filtering.
	 */
	async getOpenRouterModels() {
		const apiKey = process.env.OPENROUTER_API_KEY;
		const response = await fetch("https://openrouter.ai/api/v1/models", {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch OpenRouter models: ${response.status}`);
		}

		const data = await response.json();
		return await this.#hooks.rpc.response.result.filter(data.data, {
			method: "getOpenRouterModels",
		});
	}
}
