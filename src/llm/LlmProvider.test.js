import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import LlmProvider from "./LlmProvider.js";

function mockHooks(providers = []) {
	return { llm: { providers } };
}

describe("LlmProvider", () => {
	let originalTemp;
	beforeEach(() => {
		originalTemp = process.env.RUMMY_TEMPERATURE;
	});
	afterEach(() => {
		if (originalTemp === undefined) delete process.env.RUMMY_TEMPERATURE;
		else process.env.RUMMY_TEMPERATURE = originalTemp;
	});

	it("resolve(alias) returns models row.actual", async () => {
		const db = {
			get_model_by_alias: {
				get: async ({ alias }) =>
					alias === "gemma" ? { actual: "openai/gemma" } : null,
			},
		};
		const provider = new LlmProvider(db, mockHooks());
		assert.equal(await provider.resolve("gemma"), "openai/gemma");
	});

	it("resolve(alias) throws for unknown alias", async () => {
		const db = {
			get_model_by_alias: { get: async () => null },
		};
		const provider = new LlmProvider(db, mockHooks());
		await assert.rejects(provider.resolve("nope"), /unknown|nope/i);
	});

	it("completion: throws when no provider matches resolved model", async () => {
		const db = {
			get_model_by_alias: {
				get: async () => ({ actual: "openai/gemma" }),
			},
		};
		const provider = new LlmProvider(db, mockHooks([]));
		await assert.rejects(
			provider.completion([], "gemma"),
			/No LLM provider registered/,
		);
	});

	it("completion: dispatches to matching provider with resolved model", async () => {
		const db = {
			get_model_by_alias: {
				get: async () => ({ actual: "openai/gemma" }),
			},
		};
		let captured;
		const fakeProvider = {
			name: "openai",
			matches: (m) => m.startsWith("openai/"),
			completion: async (messages, model, options) => {
				captured = { messages, model, options };
				return { choices: [{ message: { content: "ok" } }] };
			},
		};
		const provider = new LlmProvider(db, mockHooks([fakeProvider]));
		const result = await provider.completion(
			[{ role: "user", content: "hi" }],
			"gemma",
		);
		assert.equal(result.choices[0].message.content, "ok");
		assert.equal(captured.model, "openai/gemma");
		assert.deepEqual(captured.messages, [{ role: "user", content: "hi" }]);
	});

	it("completion: pulls temperature from RUMMY_TEMPERATURE env when not in options", async () => {
		process.env.RUMMY_TEMPERATURE = "0.42";
		const db = {
			get_model_by_alias: {
				get: async () => ({ actual: "openai/gemma" }),
			},
		};
		let captured;
		const fakeProvider = {
			name: "openai",
			matches: () => true,
			completion: async (_, __, options) => {
				captured = options;
				return { choices: [{ message: { content: "" } }] };
			},
		};
		const provider = new LlmProvider(db, mockHooks([fakeProvider]));
		await provider.completion([], "gemma");
		assert.equal(captured.temperature, 0.42);
	});

	it("completion: explicit options.temperature wins over env", async () => {
		process.env.RUMMY_TEMPERATURE = "0.5";
		const db = {
			get_model_by_alias: {
				get: async () => ({ actual: "openai/gemma" }),
			},
		};
		let captured;
		const fakeProvider = {
			name: "openai",
			matches: () => true,
			completion: async (_, __, options) => {
				captured = options;
				return { choices: [{ message: { content: "" } }] };
			},
		};
		const provider = new LlmProvider(db, mockHooks([fakeProvider]));
		await provider.completion([], "gemma", { temperature: 0.05 });
		assert.equal(captured.temperature, 0.05);
	});

	it("completion: wraps context-exceeded errors as ContextExceededError", async () => {
		const db = {
			get_model_by_alias: {
				get: async () => ({ actual: "openai/gemma" }),
			},
		};
		const fakeProvider = {
			name: "openai",
			matches: () => true,
			completion: async () => {
				throw new Error("This model's maximum context length is 32768 tokens");
			},
		};
		const provider = new LlmProvider(db, mockHooks([fakeProvider]));
		await assert.rejects(provider.completion([], "gemma"), (err) => {
			assert.equal(err.name, "ContextExceededError");
			assert.match(err.message, /maximum context length/);
			assert.ok(err.cause);
			return true;
		});
	});

	it("getContextSize: returns DB-cached value when present", async () => {
		const db = {
			get_model_by_alias: {
				get: async () => ({ actual: "openai/gemma", context_length: 8192 }),
			},
			update_model_context_length: {
				run: async () => {
					throw new Error("should not write when cached");
				},
			},
		};
		const provider = new LlmProvider(db, mockHooks());
		assert.equal(await provider.getContextSize("gemma"), 8192);
	});

	it("getContextSize: probes provider + caches result on cache miss", async () => {
		const updates = [];
		let _lookups = 0;
		const db = {
			get_model_by_alias: {
				get: async () => {
					_lookups++;
					// First call: returns row without context_length.
					// Second call: also returns same (resolve looks up again).
					return { actual: "openai/gemma" };
				},
			},
			update_model_context_length: {
				run: async (params) => {
					updates.push(params);
				},
			},
		};
		const fakeProvider = {
			name: "openai",
			matches: () => true,
			getContextSize: async () => 4096,
		};
		const provider = new LlmProvider(db, mockHooks([fakeProvider]));
		assert.equal(await provider.getContextSize("gemma"), 4096);
		assert.deepEqual(updates, [{ alias: "gemma", context_length: 4096 }]);
	});

	it("getContextSize: throws when no provider matches resolved model", async () => {
		const db = {
			get_model_by_alias: {
				get: async () => ({ actual: "unknown/model" }),
			},
		};
		const provider = new LlmProvider(db, mockHooks([]));
		await assert.rejects(
			provider.getContextSize("alias"),
			/No LLM provider registered/,
		);
	});
});
