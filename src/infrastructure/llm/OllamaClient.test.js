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
});
