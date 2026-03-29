import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import ModelCapabilities from "./ModelCapabilities.js";

describe("ModelCapabilities", () => {
	it("set and get should store and retrieve metadata", () => {
		const caps = new ModelCapabilities();
		caps.set("test-model", {
			id: "test-model",
			name: "Test",
			context_length: 8192,
			supported_parameters: ["temperature", "top_p"],
			architecture: { tokenizer: "GPT" },
			pricing: { prompt: "0.01" },
			top_provider: { max_completion_tokens: 4096 },
		});

		const meta = caps.get("test-model");
		strictEqual(meta.id, "test-model");
		strictEqual(meta.name, "Test");
		strictEqual(meta.contextLength, 8192);
		strictEqual(meta.maxCompletionTokens, 4096);
		strictEqual(meta.supportedParameters.has("temperature"), true);
	});

	it("get should return null for unknown model", () => {
		const caps = new ModelCapabilities();
		strictEqual(caps.get("unknown"), null);
	});

	it("supports should check parameter presence", () => {
		const caps = new ModelCapabilities();
		caps.set("m1", {
			id: "m1",
			name: "M1",
			context_length: 4096,
			supported_parameters: ["structured_outputs"],
		});
		strictEqual(caps.supports("m1", "structured_outputs"), true);
		strictEqual(caps.supports("m1", "tools"), false);
		strictEqual(caps.supports("unknown", "anything"), false);
	});

	it("supportsPrefill should return true by default", () => {
		const caps = new ModelCapabilities();
		strictEqual(caps.supportsPrefill("unknown"), true);
	});

	it("supportsPrefill should return false for Claude tokenizer", () => {
		const caps = new ModelCapabilities();
		caps.set("claude", {
			id: "claude",
			name: "Claude",
			context_length: 200000,
			supported_parameters: [],
			architecture: { tokenizer: "Claude" },
		});
		strictEqual(caps.supportsPrefill("claude"), false);
	});

	it("supportsPrefill should return true if assistant_prefill listed", () => {
		const caps = new ModelCapabilities();
		caps.set("m2", {
			id: "m2",
			name: "M2",
			context_length: 4096,
			supported_parameters: ["assistant_prefill"],
			architecture: { tokenizer: "Claude" },
		});
		strictEqual(caps.supportsPrefill("m2"), true);
	});

	it("metadata should be frozen", () => {
		const caps = new ModelCapabilities();
		caps.set("m3", {
			id: "m3",
			name: "M3",
			context_length: 1024,
			supported_parameters: [],
		});
		const meta = caps.get("m3");
		let threw = false;
		try {
			meta.id = "modified";
		} catch {
			threw = true;
		}
		strictEqual(threw, true);
	});
});
