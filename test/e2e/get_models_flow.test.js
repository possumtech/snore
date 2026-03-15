import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E Bedrock: getOpenRouterModels (LIVE)", () => {
	let tdb;
	let tserver;
	let client;

	before(async () => {
		if (!process.env.OPENROUTER_API_KEY) {
			throw new Error("OPENROUTER_API_KEY is required for live E2E tests");
		}
		tdb = await TestDb.create("live_models");
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
	});

	after(async () => {
		if (client) client.close();
		if (tserver) await tserver.stop();
		if (tdb) await tdb.cleanup();
	});

	it("should fetch real models from OpenRouter via RPC", async () => {
		const models = await client.call("getOpenRouterModels");
		assert.ok(Array.isArray(models), "Should return an array of models");

		// DYNAMIC VERIFICATION: Ensure our default model exists in the live list
		const defaultModel = process.env.SNORE_DEFAULT_MODEL;
		const found = models.some((m) => m.id === defaultModel);

		assert.ok(
			found,
			`Live model list should contain the default model: ${defaultModel}`,
		);
	});
});
