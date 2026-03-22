import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("Happy Path E2E: France", () => {
	let tdb, tserver, client;
	const projectPath = join(process.cwd(), "test_france_project");

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });

		// Initialize git so RepoMap finds files (required by our new architecture)
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "test@test.com" && git config user.name "Test"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("should answer 'What is the capital of France?' correctly", async () => {
		// Mock the LLM Response
		globalThis.fetch = async () => {
			return new Response(
				JSON.stringify({
					model: "mock-model",
					choices: [
						{
							message: {
								role: "assistant",
								content:
									"<tasks>- [x] Answer question</tasks><known>The user is asking about France.</known><summary>The capital of France is Paris.</summary>",
							},
						},
					],
					usage: { total_tokens: 50 },
				}),
			);
		};

		const turns = [];
		client.on("run/step/completed", (params) => turns.push(params.turn));

		await client.call("init", {
			projectPath,
			projectName: "FranceProject",
			clientId: "c1",
		});

		const result = await client.call("ask", {
			model: "mock-model",
			prompt: "What is the capital of France?",
		});

		assert.strictEqual(result.status, "completed");

		// Wait a beat for async DB persistence
		await new Promise((r) => setTimeout(r, 1000));

		const turnsHistory = await client.call("getRunHistory", {
			runId: result.runId,
		});
		assert.strictEqual(turnsHistory.length, 2);

		const userMsg = turnsHistory.find((m) => m.role === "user");
		const assistantMsg = turnsHistory.find((m) => m.role === "assistant");

		assert.ok(userMsg.content.includes("France"));
		assert.ok(assistantMsg.content.includes("Paris"));

		const turn0_emitted = turns.find((t) => t.sequence === 0);
		assert.ok(
			turn0_emitted.context.includes("<context"),
			"Context should be a prettified XML string",
		);
	});
});
