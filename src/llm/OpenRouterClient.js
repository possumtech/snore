import msg from "../agent/messages.js";

const CATALOG_MAX_AGE = 24 * 60 * 60 * 1000;
const CATALOG_TIMEOUT = 120_000;

export default class OpenRouterClient {
	#apiKey;
	#baseUrl;
	#hooks;
	#capabilities;
	#db;

	constructor(apiKey, hooks, capabilities, db) {
		this.#apiKey = apiKey;
		this.#hooks = hooks;
		this.#capabilities = capabilities;
		this.#db = db;
		this.#baseUrl = process.env.OPENROUTER_BASE_URL;
	}

	async completion(messages, model, options = {}) {
		if (!this.#apiKey) throw new Error(msg("error.openrouter_api_key_missing"));
		return this.#fetch(messages, model, options);
	}

	async #fetch(messages, model, options) {
		const body = { model, messages };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeout = Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000;
		const response = await fetch(`${this.#baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.#apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": process.env.RUMMY_HTTP_REFERER,
				"X-Title": process.env.RUMMY_X_TITLE,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeout),
		});

		if (!response.ok) {
			const error = await response.text();
			if (response.status === 401 || response.status === 403) {
				throw new Error(msg("error.openrouter_auth", { status: `${response.status} - ${error}` }));
			}
			throw new Error(msg("error.openrouter_api", { status: `${response.status} - ${error}` }));
		}
		const data = await response.json();

		for (const choice of data.choices || []) {
			const cm = choice.message;
			if (!cm) continue;
			// Normalize all reasoning synonyms into reasoning_content
			const parts = [
				cm.reasoning_content,
				cm.reasoning,
				cm.thinking,
				...(cm.reasoning_details || []).map((d) => d.text),
			].filter(Boolean);
			cm.reasoning_content =
				parts.length > 0 ? [...new Set(parts)].join("\n") : null;
		}

		return data;
	}

	async refreshCatalog() {
		const response = await fetch(`${this.#baseUrl}/models`, {
			headers: { Authorization: `Bearer ${this.#apiKey}` },
			signal: AbortSignal.timeout(CATALOG_TIMEOUT),
		});
		if (!response.ok) {
			throw new Error(msg("error.openrouter_catalog", { status: response.status }));
		}
		const data = await response.json();
		for (const m of data.data || []) {
			await this.#db.upsert_provider_model.run({
				id: m.id,
				canonical_slug: m.canonical_slug || null,
				name: m.name || null,
				description: m.description || null,
				context_length: m.context_length || null,
				modality: m.architecture?.modality || null,
				tokenizer: m.architecture?.tokenizer || null,
				instruct_type: m.architecture?.instruct_type || null,
				input_modalities: JSON.stringify(
					m.architecture?.input_modalities || [],
				),
				output_modalities: JSON.stringify(
					m.architecture?.output_modalities || [],
				),
				pricing_prompt: Number(m.pricing?.prompt) || 0,
				pricing_completion: Number(m.pricing?.completion) || 0,
				pricing_input_cache_read: Number(m.pricing?.input_cache_read) || 0,
				max_completion_tokens: m.top_provider?.max_completion_tokens || null,
				is_moderated: m.top_provider?.is_moderated ? 1 : 0,
				supported_parameters: JSON.stringify(m.supported_parameters || []),
				default_parameters: JSON.stringify(m.default_parameters || {}),
				knowledge_cutoff: m.knowledge_cutoff || null,
				expiration_date: m.expiration_date || null,
				created: m.created || null,
			});
		}
		return data.data?.length || 0;
	}

	async #ensureCatalog() {
		const age = await this.#db.get_catalog_age.get({});
		if (age?.oldest) {
			const elapsed = Date.now() - new Date(`${age.oldest}Z`).getTime();
			if (elapsed < CATALOG_MAX_AGE) return;
		}
		await this.refreshCatalog();
	}

	async getContextSize(model) {
		// Check DB first
		let found = await this.#db.get_provider_model.get({ id: model });
		if (!found) {
			await this.#ensureCatalog();
			found = await this.#db.get_provider_model.get({ id: model });
		}
		if (!found) throw new Error(msg("error.openrouter_model_not_found", { model }));
		if (this.#capabilities) {
			this.#capabilities.set(model, {
				...found,
				supported_parameters: JSON.parse(found.supported_parameters || "[]"),
			});
		}
		if (!found.context_length) throw new Error(msg("error.openrouter_no_context_length", { model }));
		return found.context_length;
	}
}
