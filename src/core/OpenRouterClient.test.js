import assert from "node:assert";
import { before, describe, it, mock } from "node:test";
import OpenRouterClient from "./OpenRouterClient.js";

describe("OpenRouterClient", () => {
	before(() => {
		process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
		process.env.RUMMY_HTTP_REFERER = "http://test";
		process.env.RUMMY_X_TITLE = "Test";
	});

	it("should send a completion request", async () => {
		const mockResponse = {
			choices: [{ message: { content: "Paris" } }],
			usage: { total_tokens: 10 },
		};

		mock.method(globalThis, "fetch", async () => ({
			ok: true,
			json: async () => mockResponse,
		}));

		const client = new OpenRouterClient("test-key");
		const result = await client.completion(
			[{ role: "user", content: "Paris?" }],
			"test-model",
		);

		assert.deepStrictEqual(result, mockResponse);
	});

	it("should throw on API error", async () => {
		mock.method(globalThis, "fetch", async () => ({
			ok: false,
			status: 500,
			text: async () => "Internal Error",
		}));

		const client = new OpenRouterClient("test-key");
		await assert.rejects(
			client.completion([], "test-model"),
			/OpenRouter API error: 500 - Internal Error/,
		);
	});
});
