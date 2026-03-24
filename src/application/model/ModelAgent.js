export default class ModelAgent {
	#db;
	#hooks;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
	}

	/**
	 * Returns available model aliases from RUMMY_MODEL_ environment variables.
	 * Naming matches turn metadata: alias, actual, display.
	 */
	async getModels() {
		const defaultAlias = process.env.RUMMY_MODEL_DEFAULT;
		const models = Object.keys(process.env)
			.filter((key) => key.startsWith("RUMMY_MODEL_") && key !== "RUMMY_MODEL_DEFAULT")
			.map((key) => {
				const alias = key.replace("RUMMY_MODEL_", "");
				const target = process.env[key];
				return {
					alias,
					actual: target,
					display: alias,
					default: alias === defaultAlias,
					target,
				};
			});

		return await this.#hooks.rpc.response.result.filter(models, {
			method: "getModels",
		});
	}
}
