export default class ModelAgent {
	getModels() {
		const defaultAlias = process.env.RUMMY_MODEL_DEFAULT;
		return Object.keys(process.env)
			.filter(
				(key) =>
					key.startsWith("RUMMY_MODEL_") && key !== "RUMMY_MODEL_DEFAULT",
			)
			.map((key) => {
				const alias = key.replace("RUMMY_MODEL_", "");
				return {
					alias,
					actual: process.env[key],
					display: alias,
					default: alias === defaultAlias,
				};
			});
	}
}
