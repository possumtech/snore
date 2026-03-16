import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E Bedrock: Plugin Architecture (LIVE)", () => {
	let tdb;
	let tserver;
	let client;
	const projectPath = join(process.cwd(), "test_plugin_e2e");

	before(async () => {
		if (!process.env.OPENROUTER_API_KEY) {
			throw new Error("OPENROUTER_API_KEY is required");
		}

		tdb = await TestDb.create("plugin_e2e");
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

	it("should verify that TestE2EPlugin is loaded and seen by model", {
		timeout: 30000,
	}, async () => {
		await fs.mkdir(projectPath, { recursive: true }).catch(() => {});
		await client.call("init", {
			projectPath,
			projectName: "Plugin Test",
			clientId: "p-test-1",
		});

		const askResult = await client.call("ask", {
			model: process.env.SNORE_MODEL_DEFAULT,
			prompt: "What is the IDENTITY_KEY? (Answer with only the key)",
		});

		const content = askResult.content;
		assert.ok(
			content.includes("ALBATROSS-99"),
			`Plugin injection not found. Got: ${content}`,
		);
	});
});
