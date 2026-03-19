export default class OpenRouterClient {
	#apiKey;
	#baseUrl;
	#hooks;

	constructor(apiKey, hooks) {
		this.#apiKey = apiKey;
		this.#hooks = hooks;
		this.#baseUrl = process.env.OPENROUTER_BASE_URL;
	}

	async completion(messages, model) {
		const response = await fetch(`${this.#baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": process.env.RUMMY_HTTP_REFERER,
				"X-Title": process.env.RUMMY_X_TITLE,
			},
			body: JSON.stringify({
				model,
				messages,
			}),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
		}

		return response.json();
	}
}
