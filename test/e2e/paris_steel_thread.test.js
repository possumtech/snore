import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E Bedrock: Paris Steel Thread (LIVE)", () => {
	let tdb;
	let tserver;
	let client;
	const projectPath = join(process.cwd(), "test_paris_e2e");

	before(async () => {
		if (!process.env.OPENROUTER_API_KEY) {
			throw new Error("OPENROUTER_API_KEY is required");
		}
		await fs.mkdir(projectPath, { recursive: true }).catch(() => {});
		tdb = await TestDb.create("paris_e2e");
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
	});

	after(async () => {
		if (client) client.close();
		if (tserver) await tserver.stop();
		if (tdb) await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
	});

	it("should complete the full Paris flow via LIVE OpenRouter", {
		timeout: 30000,
	}, async () => {
		await client.call("init", {
			projectPath,
			projectName: "Paris Test",
			clientId: "paris-1",
		});

		const askResult = await client.call("ask", {
			model: process.env.SNORE_MODEL_DEFAULT,
			prompt: "What is the capital of France?",
		});

		assert.ok(askResult.content.includes("Paris"));
	});
});
