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
});
