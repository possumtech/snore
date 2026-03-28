import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import schemaToGbnf from "./gbnf.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const grammars = {
	ask: schemaToGbnf(
		JSON.parse(readFileSync(join(__dirname, "../../domain/schema/ask.json"), "utf8")),
		{ thinking: true },
	),
	act: schemaToGbnf(
		JSON.parse(readFileSync(join(__dirname, "../../domain/schema/act.json"), "utf8")),
		{ thinking: true },
	),
};

/**
 * OpenAiClient: For OpenAI-compatible local servers (llama.cpp, vllm, etc.)
 * Uses GBNF grammar for schema enforcement with required <think> preamble.
 * llama-server separates thinking into reasoning_content automatically.
 */
export default class OpenAiClient {
	#baseUrl;
	#apiKey;

	constructor(baseUrl, apiKey) {
		this.#baseUrl = String(baseUrl || "").replace(/\/v1\/?$/, "");
		this.#apiKey = apiKey || "";
	}

	async completion(messages, model, options = {}) {
		let finalMessages = messages;
		if (messages.at(-1)?.role === "assistant") {
			finalMessages = messages.slice(0, -1);
		}

		const body = { model, messages: finalMessages };
		if (options.temperature !== undefined)
			body.temperature = options.temperature;

		body.grammar = grammars[options.mode] || grammars.ask;

		const timeout = Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000;
		const headers = { "Content-Type": "application/json" };
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

		const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeout),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`OpenAI-compatible API error: ${response.status} - ${error}`);
		}

		const data = await response.json();

		for (const choice of data.choices || []) {
			const msg = choice.message;
			if (!msg) continue;

			if (msg.reasoning && !msg.reasoning_content) {
				msg.reasoning_content = msg.reasoning;
			}

			// Extract <think> blocks from content if server didn't separate them
			const thinkMatch = msg.content?.match(/^<think>([\s\S]*?)<\/think>\s*/);
			if (thinkMatch) {
				const extracted = thinkMatch[1].trim();
				msg.reasoning_content = msg.reasoning_content
					? `${msg.reasoning_content}\n${extracted}`
					: extracted;
				msg.content = msg.content.replace(/^<think>[\s\S]*?<\/think>\s*/, "");
			}
		}

		return data;
	}

	async getContextSize(_model) {
		const timeout = Number(process.env.RUMMY_FETCH_TIMEOUT) || 30_000;
		const headers = { "Content-Type": "application/json" };
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

		const response = await fetch(`${this.#baseUrl}/v1/models`, {
			headers,
			signal: AbortSignal.timeout(timeout),
		});
		if (!response.ok) {
			throw new Error(`OpenAI-compatible /v1/models failed: ${response.status}. Is the server running at ${this.#baseUrl}?`);
		}
		const data = await response.json();
		const model = data.data?.[0];
		const ctx = model?.meta?.n_ctx_train || model?.context_length;
		if (!ctx) {
			throw new Error(`OpenAI-compatible /v1/models returned no context size. Response: ${JSON.stringify(model)}`);
		}
		return ctx;
	}
}
