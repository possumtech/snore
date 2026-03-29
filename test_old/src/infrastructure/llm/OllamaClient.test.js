import assert from "node:assert";
import test from "node:test";
import OllamaClient from "./OllamaClient.js";

test("OllamaClient", async (t) => {
	const client = new OllamaClient("http://localhost:11434", {});

	await t.test("completion should return data on success", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					model: "m1",
					choices: [{ message: { content: "hi" } }],
				}),
			);

		const result = await client.completion(
			[{ role: "user", content: "hi" }],
			"m1",
		);
		assert.strictEqual(result.choices[0].message.content, "hi");
	});

	await t.test("completion should throw on error", async () => {
		globalThis.fetch = async () => new Response("error", { status: 500 });
		await assert.rejects(client.completion([], "m1"), /Ollama API error/);
	});

	await t.test("completion should strip assistant prefill", async () => {
		let capturedBody;
		globalThis.fetch = async (_url, opts) => {
			capturedBody = JSON.parse(opts.body);
			return new Response(
				JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
			);
		};
		await client.completion(
			[
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "pre" },
			],
			"m1",
		);
		assert.strictEqual(capturedBody.messages.length, 1);
		assert.strictEqual(capturedBody.messages[0].role, "user");
	});

	await t.test("completion should normalize reasoning field", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [{ message: { content: "ok", reasoning: "thought" } }],
				}),
			);
		const result = await client.completion([], "m1");
		assert.strictEqual(result.choices[0].message.reasoning_content, "thought");
	});

	await t.test("getContextSize should return context_length", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					model_info: { "general.context_length": 8192 },
				}),
			);
		const size = await client.getContextSize("m1");
		assert.strictEqual(size, 8192);
	});

	await t.test("getContextSize should throw on error", async () => {
		globalThis.fetch = async () => new Response("fail", { status: 500 });
		await assert.rejects(client.getContextSize("m1"), /Ollama/);
	});

	await t.test(
		"getContextSize should throw when no context_length key",
		async () => {
			globalThis.fetch = async () =>
				new Response(JSON.stringify({ model_info: { other_key: 42 } }));
			await assert.rejects(client.getContextSize("m1"), /no context_length/);
		},
	);
});
