import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Xai from "./xai.js";

function mockCore() {
	const providers = [];
	return { providers, hooks: { llm: { providers } } };
}

describe("Xai provider plugin", () => {
	let originalBase;
	let originalKey;
	let originalFetch;

	beforeEach(() => {
		originalBase = process.env.XAI_BASE_URL;
		originalKey = process.env.XAI_API_KEY;
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		const restore = (k, v) => {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		};
		restore("XAI_BASE_URL", originalBase);
		restore("XAI_API_KEY", originalKey);
		globalThis.fetch = originalFetch;
	});

	it("inert without XAI_BASE_URL", () => {
		delete process.env.XAI_BASE_URL;
		const core = mockCore();
		new Xai(core);
		assert.equal(core.providers.length, 0);
	});

	it("registers provider when XAI_BASE_URL set", () => {
		process.env.XAI_BASE_URL = "https://api.x.ai/v1/responses";
		const core = mockCore();
		new Xai(core);
		assert.equal(core.providers.length, 1);
		assert.equal(core.providers[0].name, "xai");
	});

	it("matches xai/* aliases only", () => {
		process.env.XAI_BASE_URL = "https://x";
		const core = mockCore();
		new Xai(core);
		const p = core.providers[0];
		assert.equal(p.matches("xai/grok-4-fast-reasoning"), true);
		assert.equal(p.matches("xai/grok-4"), true);
		assert.equal(p.matches("openrouter/xai/grok"), false);
	});

	it("completion: throws when XAI_API_KEY missing", async () => {
		process.env.XAI_BASE_URL = "https://x";
		delete process.env.XAI_API_KEY;
		const core = mockCore();
		new Xai(core);
		await assert.rejects(
			core.providers[0].completion([], "xai/grok", {}),
			/api[ _]?key/i,
		);
	});

	it("completion: includes prompt_cache_key when runAlias provided", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		let captured;
		globalThis.fetch = async (_url, init) => {
			captured = JSON.parse(init.body);
			return {
				ok: true,
				json: async () => ({
					output: [
						{ type: "message", content: [{ type: "output_text", text: "hi" }] },
					],
					usage: { input_tokens: 10, output_tokens: 5 },
				}),
			};
		};
		const core = mockCore();
		new Xai(core);
		await core.providers[0].completion([], "xai/grok", {
			runAlias: "cli_123",
		});
		assert.equal(captured.prompt_cache_key, "cli_123");
	});

	it("completion: omits prompt_cache_key when runAlias absent", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		let captured;
		globalThis.fetch = async (_url, init) => {
			captured = JSON.parse(init.body);
			return {
				ok: true,
				json: async () => ({
					output: [
						{ type: "message", content: [{ type: "output_text", text: "x" }] },
					],
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
			};
		};
		const core = mockCore();
		new Xai(core);
		await core.providers[0].completion([], "xai/grok", {});
		assert.equal(captured.prompt_cache_key, undefined);
	});

	it("completion: 401/403 throws auth-tagged error with status", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		globalThis.fetch = async () => ({
			ok: false,
			status: 401,
			text: async () => "bad key",
			headers: { get: () => null },
		});
		const core = mockCore();
		new Xai(core);
		await assert.rejects(
			core.providers[0].completion([], "xai/grok", {}),
			(err) => {
				assert.equal(err.status, 401);
				return true;
			},
		);
	});

	it("completion: non-auth status surfaces err.status, err.body, err.retryAfter", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		globalThis.fetch = async () => ({
			ok: false,
			status: 429,
			text: async () => "rate limited",
			headers: { get: (k) => (k === "retry-after" ? "12" : null) },
		});
		const core = mockCore();
		new Xai(core);
		await assert.rejects(
			core.providers[0].completion([], "xai/grok", {}),
			(err) => {
				assert.equal(err.status, 429);
				assert.equal(err.body, "rate limited");
				assert.equal(err.retryAfter, 12);
				return true;
			},
		);
	});

	it("normalize: extracts message + reasoning into OpenAI-shape choices", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({
				output: [
					{
						type: "reasoning",
						content: [{ type: "text", text: "thinking..." }],
					},
					{
						type: "message",
						content: [{ type: "output_text", text: "answer" }],
					},
				],
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					input_tokens_details: { cached_tokens: 3 },
					output_tokens_details: { reasoning_tokens: 2 },
					cost_in_usd_ticks: 100_000_000_000,
				},
			}),
		});
		const core = mockCore();
		new Xai(core);
		const result = await core.providers[0].completion([], "xai/grok", {});
		assert.equal(result.choices[0].message.content, "answer");
		assert.equal(result.choices[0].message.reasoning_content, "thinking...");
		assert.equal(result.usage.prompt_tokens, 10);
		assert.equal(result.usage.completion_tokens, 5);
		assert.equal(result.usage.cached_tokens, 3);
		assert.equal(result.usage.reasoning_tokens, 2);
		assert.equal(result.usage.total_tokens, 15);
		assert.equal(result.usage.cost, 10);
	});

	it("normalize: handles missing optional usage fields with 0 defaults", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "x" }],
					},
				],
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		});
		const core = mockCore();
		new Xai(core);
		const result = await core.providers[0].completion([], "xai/grok", {});
		assert.equal(result.usage.cached_tokens, 0);
		assert.equal(result.usage.reasoning_tokens, 0);
		assert.equal(result.usage.cost, 0);
	});

	it("normalize: concatenates multiple message items with \\n", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: "first" }],
					},
					{
						type: "message",
						content: [{ type: "output_text", text: "second" }],
					},
				],
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		});
		const core = mockCore();
		new Xai(core);
		const result = await core.providers[0].completion([], "xai/grok", {});
		assert.equal(result.choices[0].message.content, "first\nsecond");
	});

	it("normalize: handles content as raw string (vs array)", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({
				output: [{ type: "message", content: "raw string" }],
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		});
		const core = mockCore();
		new Xai(core);
		const result = await core.providers[0].completion([], "xai/grok", {});
		assert.equal(result.choices[0].message.content, "raw string");
	});
});
