import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E: Reasoning Content Normalization", () => {
	let tdb, tserver, client;

	before(async () => {
		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
	});

	it("should capture reasoning from 'reasoning_content' (OpenRouter style)", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								role: "assistant",
								content:
									"<tasks>T</tasks><known>K</known><unknown/><summary>S</summary>",
								reasoning_content: "I am thinking via OpenRouter...",
							},
						},
					],
				}),
			);

		const turns = [];
		client.on("run/step/completed", (params) => turns.push(params.turn));

		await client.call("init", {
			projectPath: process.cwd(),
			projectName: "P1",
			clientId: "c1",
		});
		await client.call("ask", { model: "m1", prompt: "Test" });

		assert.ok(turns.length > 0);
		assert.strictEqual(
			turns[0].assistant.reasoning,
			"I am thinking via OpenRouter...",
		);
	});

	it("should capture reasoning from 'reasoning' (Ollama style)", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								role: "assistant",
								content:
									"<tasks>T</tasks><known>K</known><unknown/><summary>S</summary>",
								reasoning: "I am thinking via Ollama...",
							},
						},
					],
				}),
			);

		const turns = [];
		client.on("run/step/completed", (params) => turns.push(params.turn));

		await client.call("ask", { model: "m1", prompt: "Test" });

		// Turn 0 was the previous test, this should be turn 1 or we check the last emitted
		const lastTurn = turns[turns.length - 1];
		assert.strictEqual(
			lastTurn.assistant.reasoning,
			"I am thinking via Ollama...",
		);
	});
});
