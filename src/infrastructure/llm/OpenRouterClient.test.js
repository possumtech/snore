import assert from "node:assert";
import test from "node:test";
import OpenRouterClient from "./OpenRouterClient.js";

test("OpenRouterClient", async (t) => {
	const client = new OpenRouterClient("key", {});

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
		await assert.rejects(client.completion([], "m1"), /OpenRouter API error/);
	});

	await t.test("completion should throw on auth error", async () => {
		globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
		await assert.rejects(client.completion([], "m1"), /Authentication Error/);
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
			[{ role: "user", content: "hi" }, { role: "assistant", content: "pre" }],
			"m1",
		);
		assert.strictEqual(capturedBody.messages.length, 1);
	});

	await t.test("completion should throw without API key", async () => {
		const noKeyClient = new OpenRouterClient(null, {});
		await assert.rejects(noKeyClient.completion([], "m1"), /API key is missing/);
	});

	await t.test("getContextSize should return context_length", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({ data: [{ id: "m1", context_length: 16384 }] }),
			);
		const size = await client.getContextSize("m1");
		assert.strictEqual(size, 16384);
	});

	await t.test("getContextSize should throw on error", async () => {
		globalThis.fetch = async () => new Response("fail", { status: 500 });
		await assert.rejects(client.getContextSize("m1"), /OpenRouter/);
	});

	await t.test("getContextSize should throw for unknown model", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ data: [{ id: "other", context_length: 4096 }] }));
		await assert.rejects(client.getContextSize("m1"), /not found/);
	});
});
