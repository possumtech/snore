import msg from "../../agent/messages.js";
import { chatCompletionStream } from "../../llm/openaiStream.js";

const FETCH_TIMEOUT = Number(process.env.RUMMY_FETCH_TIMEOUT);

const PROVIDER = "xai";

// Inert unless XAI_BASE_URL set; xai/{model} aliases.
//
// XAI_BASE_URL points at xAI's v1 root (e.g. https://api.x.ai/v1).
// We POST to {base}/chat/completions and stream the response via the
// shared OpenAI-compatible client — this is the path that surfaces
// reasoning_content deltas. The /v1/responses endpoint is xAI's newer
// API but its non-streaming output drops reasoning content (we still
// pay for it via reasoning_tokens; we just never see it). Streaming on
// /v1/responses uses a different event shape that our shared stream
// client doesn't speak. So we use /v1/chat/completions: caching is
// preserved via the `x-grok-conv-id` header (xAI's chat-completions
// equivalent of the /v1/responses `prompt_cache_key` body field).
// See https://docs.x.ai/developers/advanced-api-usage/prompt-caching.
export default class Xai {
	#baseUrl;
	#apiKey;
	#contextCache = new Map();

	constructor(core) {
		const baseUrl = process.env.XAI_BASE_URL;
		if (!baseUrl) return;
		this.#baseUrl = baseUrl.replace(/\/$/, "");
		// Fail-fast on the legacy `/v1/responses` endpoint (used in earlier
		// rummy versions before we switched to streaming /chat/completions).
		// Composing `${baseUrl}/chat/completions` against a stale shell
		// `XAI_BASE_URL=https://api.x.ai/v1/responses` produces a 404 route
		// that escapes to AgentLoop's outer catch and 500-storms a sweep
		// silently. Throwing at construction surfaces the env trap before
		// any task starts (verified pathology: 2026-05-01 sweep, 31/31
		// status=500). xAI's API root ends in `/v1`; anything else is wrong.
		if (!/\/v1$/.test(this.#baseUrl)) {
			throw new Error(
				`XAI_BASE_URL must be the API root ending in /v1 (got "${this.#baseUrl}"). ` +
					"Likely a stale shell env from earlier /v1/responses usage; " +
					"set XAI_BASE_URL=https://api.x.ai/v1 (or the relevant proxy root).",
			);
		}
		this.#apiKey = process.env.XAI_API_KEY;

		const wireModel = (alias) => alias.split("/").slice(1).join("/");

		core.hooks.llm.providers.push({
			name: PROVIDER,
			matches: (model) => model.split("/")[0] === PROVIDER,
			completion: (messages, model, options) =>
				this.#completion(messages, wireModel(model), options),
			getContextSize: (model) => this.#getContextSize(wireModel(model)),
		});
	}

	async #completion(messages, model, options = {}) {
		if (!this.#apiKey) throw new Error(msg("error.xai_api_key_missing"));

		const body = { model, messages };
		if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
		const signal = options.signal
			? AbortSignal.any([options.signal, timeoutSignal])
			: timeoutSignal;

		const headers = {
			Authorization: `Bearer ${this.#apiKey}`,
		};
		// Pin caching to the run alias. xAI's chat-completions cache is
		// per-server; same conv-id routes to the same backend, which is
		// where the cached prefix lives. Without this, requests load-
		// balance across servers and cached_tokens stays near zero.
		if (options.runAlias) headers["x-grok-conv-id"] = options.runAlias;

		try {
			return await chatCompletionStream({
				url: `${this.#baseUrl}/chat/completions`,
				headers,
				body,
				signal,
			});
		} catch (err) {
			if (err.status === 401 || err.status === 403) {
				throw new Error(
					msg("error.xai_auth", {
						status: `${err.status} - ${err.body}`,
					}),
				);
			}
			if (err.status) {
				throw new Error(
					msg("error.xai_api", {
						status: `${err.status} - ${err.body}`,
					}),
				);
			}
			throw err;
		}
	}

	async #getContextSize(model) {
		if (this.#contextCache.has(model)) return this.#contextCache.get(model);
		if (!this.#apiKey) throw new Error(msg("error.xai_api_key_missing"));

		const res = await fetch(`${this.#baseUrl}/models`, {
			headers: { Authorization: `Bearer ${this.#apiKey}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT),
		});
		if (res.ok) {
			const data = await res.json();
			// xAI /models response shape varies by API version.
			let models;
			if (data.data) models = data.data;
			else if (data.models) models = data.models;
			else throw new Error("xAI /models response has neither data nor models");
			const entry = models.find(
				(m) => m.id === model || `${m.id}-latest` === model,
			);
			if (entry?.context_length) {
				this.#contextCache.set(model, entry.context_length);
				return entry.context_length;
			}
		}

		const langUrl = `${this.#baseUrl}/language-models/${model}`;
		// Optional probe; failure falls through to terminal throw below.
		const langRes = await fetch(langUrl, {
			headers: { Authorization: `Bearer ${this.#apiKey}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT),
		}).catch(() => null);
		if (langRes?.ok) {
			const langData = await langRes.json();
			if (langData?.context_length) {
				this.#contextCache.set(model, langData.context_length);
				return langData.context_length;
			}
		}

		throw new Error(
			`Cannot determine context size for xAI model "${model}". ` +
				"Register the model with addModel(contextLength) or set context_length in the models table.",
		);
	}
}
