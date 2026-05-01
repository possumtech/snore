import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import OpenRouter from "./openrouter.js";

function mockCore() {
	const providers = [];
	return { providers, hooks: { llm: { providers } } };
}

describe("OpenRouter provider plugin", () => {
	let originalKey;
	let originalBase;
	let originalReferer;
	let originalTitle;
	let originalFetch;

	beforeEach(() => {
		originalKey = process.env.OPENROUTER_API_KEY;
		originalBase = process.env.OPENROUTER_BASE_URL;
		originalReferer = process.env.RUMMY_HTTP_REFERER;
		originalTitle = process.env.RUMMY_X_TITLE;
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		const restore = (k, v) => {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		};
		restore("OPENROUTER_API_KEY", originalKey);
		restore("OPENROUTER_BASE_URL", originalBase);
		restore("RUMMY_HTTP_REFERER", originalReferer);
		restore("RUMMY_X_TITLE", originalTitle);
		globalThis.fetch = originalFetch;
	});

	it("inert without API key", () => {
		delete process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
		const core = mockCore();
		new OpenRouter(core);
		assert.equal(core.providers.length, 0);
	});

	it("inert without base URL", () => {
		process.env.OPENROUTER_API_KEY = "or-test";
		delete process.env.OPENROUTER_BASE_URL;
		const core = mockCore();
		new OpenRouter(core);
		assert.equal(core.providers.length, 0);
	});

	it("registers provider when both key and base URL set", () => {
		process.env.OPENROUTER_API_KEY = "or-test";
		process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
		const core = mockCore();
		new OpenRouter(core);
		assert.equal(core.providers.length, 1);
		assert.equal(core.providers[0].name, "openrouter");
	});

	it("matches openrouter/* aliases", () => {
		process.env.OPENROUTER_API_KEY = "or-test";
		process.env.OPENROUTER_BASE_URL = "https://x";
		const core = mockCore();
		new OpenRouter(core);
		const p = core.providers[0];
		assert.equal(p.matches("openrouter/x-ai/grok-4.1-fast"), true);
		assert.equal(p.matches("openai/x"), false);
	});

	it("getContextSize: returns cached value on subsequent calls", async () => {
		process.env.OPENROUTER_API_KEY = "or-test";
		process.env.OPENROUTER_BASE_URL = "https://or";
		let fetchCount = 0;
		globalThis.fetch = async () => {
			fetchCount++;
			return {
				ok: true,
				json: async () => ({
					data: [{ id: "anthropic/claude-3.5", context_length: 200000 }],
				}),
			};
		};

		const core = mockCore();
		new OpenRouter(core);
		const first = await core.providers[0].getContextSize(
			"openrouter/anthropic/claude-3.5",
		);
		const second = await core.providers[0].getContextSize(
			"openrouter/anthropic/claude-3.5",
		);
		assert.equal(first, 200000);
		assert.equal(second, 200000);
		assert.equal(fetchCount, 1, "should cache after first hit");
	});

	it("getContextSize: throws on /models non-2xx", async () => {
		process.env.OPENROUTER_API_KEY = "or-test";
		process.env.OPENROUTER_BASE_URL = "https://or";
		globalThis.fetch = async () => ({ ok: false, status: 502 });

		const core = mockCore();
		new OpenRouter(core);
		await assert.rejects(
			core.providers[0].getContextSize("openrouter/x"),
			/502|cannot resolve/i,
		);
	});

	it("getContextSize: throws when model entry has no context_length", async () => {
		process.env.OPENROUTER_API_KEY = "or-test";
		process.env.OPENROUTER_BASE_URL = "https://or";
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({ data: [{ id: "x" }] }),
		});

		const core = mockCore();
		new OpenRouter(core);
		await assert.rejects(
			core.providers[0].getContextSize("openrouter/x"),
			/no context_length/i,
		);
	});

	it("completion: includes Authorization, HTTP-Referer, X-Title headers", async () => {
		process.env.OPENROUTER_API_KEY = "or-test";
		process.env.OPENROUTER_BASE_URL = "https://or";
		process.env.RUMMY_HTTP_REFERER = "https://example.com";
		process.env.RUMMY_X_TITLE = "rummy";
		let captured;
		globalThis.fetch = async (_url, init) => {
			captured = init.headers;
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
		new OpenRouter(core);
		await core.providers[0].completion(
			[],
			"openrouter/anthropic/claude-3.5",
			{},
		);
		assert.equal(captured.Authorization, "Bearer or-test");
		assert.equal(captured["HTTP-Referer"], "https://example.com");
		assert.equal(captured["X-Title"], "rummy");
	});

	it("completion: hardcodes include_reasoning: true (orthogonal to RUMMY_THINK)", async () => {
		process.env.OPENROUTER_API_KEY = "or-test";
		process.env.OPENROUTER_BASE_URL = "https://or";
		let capturedBody;
		globalThis.fetch = async (_url, init) => {
			capturedBody = JSON.parse(init.body);
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
		new OpenRouter(core);
		await core.providers[0].completion([], "openrouter/x", {});
		assert.equal(capturedBody.include_reasoning, true);
	});

	it("completion: rewrites 401/403 to openrouter_auth error", async () => {
		process.env.OPENROUTER_API_KEY = "or-test";
		process.env.OPENROUTER_BASE_URL = "https://or";
		globalThis.fetch = async () => ({
			ok: false,
			status: 401,
			text: async () => "bad key",
			headers: { get: () => null },
		});

		const core = mockCore();
		new OpenRouter(core);
		await assert.rejects(
			core.providers[0].completion([], "openrouter/x", {}),
			/401/,
		);
	});

	it("completion: rewrites other status errors to openrouter_api template", async () => {
		process.env.OPENROUTER_API_KEY = "or-test";
		process.env.OPENROUTER_BASE_URL = "https://or";
		globalThis.fetch = async () => ({
			ok: false,
			status: 500,
			text: async () => "boom",
			headers: { get: () => null },
		});

		const core = mockCore();
		new OpenRouter(core);
		await assert.rejects(
			core.providers[0].completion([], "openrouter/x", {}),
			/500/,
		);
	});
});
