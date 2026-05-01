import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Xai from "./xai.js";

function mockCore() {
	const providers = [];
	return { providers, hooks: { llm: { providers } } };
}

// Streaming-style fetch stub: emits a single SSE chunk wrapping the
// provided assistant content (and optional reasoning), then [DONE].
function streamingFetch({
	content = "",
	reasoning = null,
	usage = null,
	captureRef = {},
} = {}) {
	return async (url, init) => {
		captureRef.url = url;
		captureRef.init = init;
		captureRef.headers = init.headers;
		captureRef.body = JSON.parse(init.body);
		const delta = { content };
		if (reasoning !== null) delta.reasoning_content = reasoning;
		const chunk = {
			choices: [{ delta, index: 0, finish_reason: null }],
		};
		const finalChunk = {
			choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
			usage,
		};
		const lines = [
			`data: ${JSON.stringify(chunk)}\n\n`,
			`data: ${JSON.stringify(finalChunk)}\n\n`,
			"data: [DONE]\n\n",
		];
		return {
			ok: true,
			body: new ReadableStream({
				start(c) {
					for (const l of lines) c.enqueue(new TextEncoder().encode(l));
					c.close();
				},
			}),
		};
	};
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
		process.env.XAI_BASE_URL = "https://api.x.ai/v1";
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

	it("completion: POSTs to {base}/chat/completions with messages body", async () => {
		process.env.XAI_BASE_URL = "https://api.x.ai/v1";
		process.env.XAI_API_KEY = "xai-test";
		const cap = {};
		globalThis.fetch = streamingFetch({ content: "hi", captureRef: cap });
		const core = mockCore();
		new Xai(core);
		await core.providers[0].completion(
			[{ role: "user", content: "ping" }],
			"xai/grok",
			{},
		);
		assert.equal(cap.url, "https://api.x.ai/v1/chat/completions");
		assert.deepEqual(cap.body.messages, [{ role: "user", content: "ping" }]);
		assert.equal(cap.body.model, "grok");
	});

	it("completion: pins cache via x-grok-conv-id header when runAlias provided", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		const cap = {};
		globalThis.fetch = streamingFetch({ captureRef: cap });
		const core = mockCore();
		new Xai(core);
		await core.providers[0].completion([], "xai/grok", {
			runAlias: "cli_123",
		});
		assert.equal(cap.headers["x-grok-conv-id"], "cli_123");
	});

	it("completion: omits x-grok-conv-id when runAlias absent", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		const cap = {};
		globalThis.fetch = streamingFetch({ captureRef: cap });
		const core = mockCore();
		new Xai(core);
		await core.providers[0].completion([], "xai/grok", {});
		assert.equal(cap.headers["x-grok-conv-id"], undefined);
	});

	it("completion: includes Authorization bearer header", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		const cap = {};
		globalThis.fetch = streamingFetch({ captureRef: cap });
		const core = mockCore();
		new Xai(core);
		await core.providers[0].completion([], "xai/grok", {});
		assert.equal(cap.headers.Authorization, "Bearer xai-test");
	});

	it("completion: includes temperature when provided in options", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		const cap = {};
		globalThis.fetch = streamingFetch({ captureRef: cap });
		const core = mockCore();
		new Xai(core);
		await core.providers[0].completion([], "xai/grok", { temperature: 0.42 });
		assert.equal(cap.body.temperature, 0.42);
	});

	it("completion: surfaces reasoning_content from streamed deltas", async () => {
		process.env.XAI_BASE_URL = "https://x";
		process.env.XAI_API_KEY = "xai-test";
		globalThis.fetch = streamingFetch({
			content: "answer",
			reasoning: "thinking...",
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
			},
		});
		const core = mockCore();
		new Xai(core);
		const result = await core.providers[0].completion([], "xai/grok", {});
		assert.equal(result.choices[0].message.content, "answer");
		assert.equal(result.choices[0].message.reasoning_content, "thinking...");
		assert.equal(result.usage.prompt_tokens, 10);
		assert.equal(result.usage.completion_tokens, 5);
	});

	it("completion: 401 throws auth-tagged error with status preserved", async () => {
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
			/401/,
		);
	});

	it("completion: non-auth status surfaces error with status code", async () => {
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
			/429/,
		);
	});

	it("completion: trailing slash on XAI_BASE_URL is normalized", async () => {
		process.env.XAI_BASE_URL = "https://api.x.ai/v1/";
		process.env.XAI_API_KEY = "xai-test";
		const cap = {};
		globalThis.fetch = streamingFetch({ captureRef: cap });
		const core = mockCore();
		new Xai(core);
		await core.providers[0].completion([], "xai/grok", {});
		assert.equal(cap.url, "https://api.x.ai/v1/chat/completions");
	});
});
