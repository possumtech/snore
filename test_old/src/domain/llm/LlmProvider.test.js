import { strictEqual, throws } from "node:assert";
import { describe, it, mock } from "node:test";
import OllamaClient from "../../infrastructure/llm/OllamaClient.js";
import OpenRouterClient from "../../infrastructure/llm/OpenRouterClient.js";
import LlmProvider from "./LlmProvider.js";

describe("LlmProvider", () => {
	it("should route to OllamaClient when alias resolves to ollama/ prefix", async () => {
		process.env.RUMMY_MODEL_local_llama = "ollama/llama3";

		const completionMock = mock.method(
			OllamaClient.prototype,
			"completion",
			async (_messages, model) => {
				strictEqual(model, "llama3");
				return "ollama result";
			},
		);

		const provider = new LlmProvider({});
		const result = await provider.completion([], "local_llama");

		strictEqual(result, "ollama result");
		strictEqual(completionMock.mock.callCount(), 1);

		completionMock.mock.restore();
		delete process.env.RUMMY_MODEL_local_llama;
	});

	it("should route to OpenRouterClient when alias resolves to non-ollama model", async () => {
		process.env.RUMMY_MODEL_gpt = "gpt-4";

		const completionMock = mock.method(
			OpenRouterClient.prototype,
			"completion",
			async (_messages, model) => {
				strictEqual(model, "gpt-4");
				return "openrouter result";
			},
		);

		const provider = new LlmProvider({});
		const result = await provider.completion([], "gpt");

		strictEqual(result, "openrouter result");
		strictEqual(completionMock.mock.callCount(), 1);

		completionMock.mock.restore();
		delete process.env.RUMMY_MODEL_gpt;
	});

	it("should throw for undefined alias", () => {
		throws(
			() => LlmProvider.resolve("nonexistent"),
			/Unknown model alias 'nonexistent'/,
		);
	});
});
