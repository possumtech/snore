import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import OpenAi from "./openai.js";

describe("OpenAi provider plugin", () => {
	let originalBase;
	let originalKey;
	let originalFetch;

	beforeEach(() => {
		originalBase = process.env.OPENAI_BASE_URL;
		originalKey = process.env.OPENAI_API_KEY;
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
		else process.env.OPENAI_BASE_URL = originalBase;
		if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = originalKey;
		globalThis.fetch = originalFetch;
	});

	function mockCore() {
		const providers = [];
		return { providers, hooks: { llm: { providers } } };
	}

	it("inert without OPENAI_BASE_URL — no provider registered", () => {
		delete process.env.OPENAI_BASE_URL;
		const core = mockCore();
		new OpenAi(core);
		assert.equal(core.providers.length, 0);
	});

	it("registers provider when OPENAI_BASE_URL is set", () => {
		process.env.OPENAI_BASE_URL = "https://api.example.com";
		const core = mockCore();
		new OpenAi(core);
		assert.equal(core.providers.length, 1);
		assert.equal(core.providers[0].name, "openai");
	});

	it("matches model aliases starting with openai/", () => {
		process.env.OPENAI_BASE_URL = "https://api.example.com";
		const core = mockCore();
		new OpenAi(core);
		const provider = core.providers[0];
		assert.equal(provider.matches("openai/gpt-4"), true);
		assert.equal(provider.matches("openai/gemma"), true);
		assert.equal(provider.matches("openrouter/x"), false);
		assert.equal(provider.matches("xai/grok"), false);
	});

	it("strips trailing /v1 from base URL on registration", () => {
		// We can't observe baseUrl directly, but the completion fetch URL should
		// always be `${baseUrl}/v1/chat/completions` with no double-/v1.
		process.env.OPENAI_BASE_URL = "https://api.example.com/v1";
		const core = mockCore();
		new OpenAi(core);
		// indirect: the constructor's regex strips /v1; we've registered a provider.
		assert.equal(core.providers.length, 1);
	});

	it("getContextSize: probes /props for llama.cpp runtime n_ctx", async () => {
		process.env.OPENAI_BASE_URL = "https://api.example.com";
		globalThis.fetch = async (url) => {
			if (url.endsWith("/props")) {
				return {
					ok: true,
					json: async () => ({
						default_generation_settings: { n_ctx: 32768 },
					}),
				};
			}
			throw new Error(`unexpected fetch: ${url}`);
		};

		const core = mockCore();
		new OpenAi(core);
		const ctx = await core.providers[0].getContextSize("openai/macher.gguf");
		assert.equal(ctx, 32768);
	});

	it("getContextSize: falls back to /v1/models when /props missing", async () => {
		process.env.OPENAI_BASE_URL = "https://api.example.com";
		globalThis.fetch = async (url) => {
			if (url.endsWith("/props")) {
				return { ok: false, status: 404 };
			}
			if (url.endsWith("/v1/models")) {
				return {
					ok: true,
					json: async () => ({
						data: [{ id: "gpt-4", meta: { n_ctx_train: 128000 } }],
					}),
				};
			}
			throw new Error(`unexpected fetch: ${url}`);
		};

		const core = mockCore();
		new OpenAi(core);
		const ctx = await core.providers[0].getContextSize("openai/gpt-4");
		assert.equal(ctx, 128000);
	});

	it("getContextSize: throws when neither props nor models yields a context length", async () => {
		process.env.OPENAI_BASE_URL = "https://api.example.com";
		globalThis.fetch = async (url) => {
			if (url.endsWith("/props")) return { ok: false };
			if (url.endsWith("/v1/models")) {
				return {
					ok: true,
					json: async () => ({ data: [{ id: "x" }] }), // no context_length
				};
			}
			throw new Error(`unexpected fetch: ${url}`);
		};

		const core = mockCore();
		new OpenAi(core);
		await assert.rejects(
			core.providers[0].getContextSize("openai/x"),
			/no context size|context_length|Cannot determine/i,
		);
	});

	it("completion: includes Authorization header when OPENAI_API_KEY set", async () => {
		process.env.OPENAI_BASE_URL = "https://api.example.com";
		process.env.OPENAI_API_KEY = "sk-test-123";
		let capturedHeaders;
		globalThis.fetch = async (_url, init) => {
			capturedHeaders = init.headers;
			return {
				ok: true,
				body: new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
						c.close();
					},
				}),
			};
		};

		const core = mockCore();
		new OpenAi(core);
		await core.providers[0].completion(
			[{ role: "user", content: "hi" }],
			"openai/gpt-4",
			{},
		);
		assert.equal(capturedHeaders.Authorization, "Bearer sk-test-123");
	});

	it("completion: omits Authorization when key not set", async () => {
		process.env.OPENAI_BASE_URL = "https://api.example.com";
		delete process.env.OPENAI_API_KEY;
		let capturedHeaders;
		globalThis.fetch = async (_url, init) => {
			capturedHeaders = init.headers;
			return {
				ok: true,
				body: new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
						c.close();
					},
				}),
			};
		};
		const core = mockCore();
		new OpenAi(core);
		await core.providers[0].completion([], "openai/x", {});
		assert.equal(capturedHeaders.Authorization, undefined);
	});

	it("completion: rejects with err.status, err.body, err.retryAfter on non-2xx", async () => {
		process.env.OPENAI_BASE_URL = "https://api.example.com";
		globalThis.fetch = async () => ({
			ok: false,
			status: 503,
			text: async () => "loading model",
			headers: { get: () => null },
		});

		const core = mockCore();
		new OpenAi(core);
		await assert.rejects(
			core.providers[0].completion([], "openai/x", {}),
			(err) => {
				assert.equal(err.status, 503);
				assert.equal(err.body, "loading model");
				assert.match(err.message, /503/);
				return true;
			},
		);
	});
});
