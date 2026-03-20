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
		if (!this.#apiKey) {
			throw new Error(
				"OpenRouter API key is missing. Please set OPENROUTER_API_KEY in your environment.",
			);
		}
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
			if (response.status === 401 || response.status === 403) {
				throw new Error(
					`OpenRouter Authentication Error: ${response.status} - ${error}. Please check your OPENROUTER_API_KEY.`,
				);
			}
			throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
		}
		return response.json();
	}
}
