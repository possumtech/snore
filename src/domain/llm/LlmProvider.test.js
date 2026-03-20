import { strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import OllamaClient from "../../infrastructure/llm/OllamaClient.js";
import OpenRouterClient from "../../infrastructure/llm/OpenRouterClient.js";
import LlmProvider from "./LlmProvider.js";

describe("LlmProvider", () => {
	it("should route completion requests to OllamaClient when model starts with ollama/", async () => {
		const completionMock = mock.method(
			OllamaClient.prototype,
			"completion",
			async (_messages, model) => {
				strictEqual(model, "llama3");
				return "ollama result";
			},
		);

		const provider = new LlmProvider({});
		const result = await provider.completion([], "ollama/llama3");

		strictEqual(result, "ollama result");
		strictEqual(completionMock.mock.callCount(), 1);

		completionMock.mock.restore();
	});

	it("should route completion requests to OpenRouterClient by default", async () => {
		const completionMock = mock.method(
			OpenRouterClient.prototype,
			"completion",
			async (_messages, model) => {
				strictEqual(model, "gpt-4");
				return "openrouter result";
			},
		);

		const provider = new LlmProvider({});
		const result = await provider.completion([], "gpt-4");

		strictEqual(result, "openrouter result");
		strictEqual(completionMock.mock.callCount(), 1);

		completionMock.mock.restore();
	});
});
