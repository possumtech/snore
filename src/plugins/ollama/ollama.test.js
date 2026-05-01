import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Ollama from "./ollama.js";

function mockCore() {
	const providers = [];
	return { providers, hooks: { llm: { providers } } };
}

describe("Ollama provider plugin", () => {
	let original;
	let originalFetch;

	beforeEach(() => {
		original = process.env.OLLAMA_BASE_URL;
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		if (original === undefined) delete process.env.OLLAMA_BASE_URL;
		else process.env.OLLAMA_BASE_URL = original;
		globalThis.fetch = originalFetch;
	});

	it("inert without OLLAMA_BASE_URL", () => {
		delete process.env.OLLAMA_BASE_URL;
		const core = mockCore();
		new Ollama(core);
		assert.equal(core.providers.length, 0);
	});

	it("registers provider with base URL set", () => {
		process.env.OLLAMA_BASE_URL = "http://localhost:11434";
		const core = mockCore();
		new Ollama(core);
		assert.equal(core.providers.length, 1);
		assert.equal(core.providers[0].name, "ollama");
	});

	it("matches ollama/* aliases only", () => {
		process.env.OLLAMA_BASE_URL = "http://x";
		const core = mockCore();
		new Ollama(core);
		const p = core.providers[0];
		assert.equal(p.matches("ollama/llama3"), true);
		assert.equal(p.matches("ollama/llama3/registry"), true);
		assert.equal(p.matches("openai/x"), false);
	});

	it("getContextSize: extracts *.context_length from model_info", async () => {
		process.env.OLLAMA_BASE_URL = "http://localhost:11434";
		globalThis.fetch = async (url) => {
			if (url.endsWith("/api/show")) {
				return {
					ok: true,
					json: async () => ({
						model_info: {
							"llama.attention.head_count": 32,
							"llama.context_length": 4096,
						},
					}),
				};
			}
			throw new Error(`unexpected url ${url}`);
		};

		const core = mockCore();
		new Ollama(core);
		assert.equal(await core.providers[0].getContextSize("ollama/llama3"), 4096);
	});

	it("getContextSize: throws when model_info has no context_length entry", async () => {
		process.env.OLLAMA_BASE_URL = "http://localhost:11434";
		globalThis.fetch = async () => ({
			ok: true,
			json: async () => ({ model_info: { "x.attention.head": 1 } }),
		});

		const core = mockCore();
		new Ollama(core);
		await assert.rejects(
			core.providers[0].getContextSize("ollama/llama3"),
			/context_length|context size/i,
		);
	});

	it("getContextSize: surfaces api/show non-2xx as Ollama-tagged error", async () => {
		process.env.OLLAMA_BASE_URL = "http://localhost:11434";
		globalThis.fetch = async () => ({ ok: false, status: 500 });

		const core = mockCore();
		new Ollama(core);
		await assert.rejects(core.providers[0].getContextSize("ollama/x"));
	});

	it("completion: rewrites status-bearing errors with ollama_api template", async () => {
		process.env.OLLAMA_BASE_URL = "http://localhost:11434";
		globalThis.fetch = async () => ({
			ok: false,
			status: 503,
			text: async () => "loading",
			headers: { get: () => null },
		});

		const core = mockCore();
		new Ollama(core);
		await assert.rejects(
			core.providers[0].completion([], "ollama/x", {}),
			(err) => {
				assert.match(err.message, /503/);
				return true;
			},
		);
	});
});
