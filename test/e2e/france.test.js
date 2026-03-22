import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("Happy Path E2E: France", () => {
	let tdb, tserver, client;
	const projectPath = join(process.cwd(), "test_project_france");

	before(async () => {
		// Prepare a dummy project
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "main.js"), "console.log('hi');");

		// Initialize Git
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "test@test.com" && git config user.name "Test" && git add . && git commit -m "feat: init"',
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
		const turns = [];
		client.on("run/step/completed", (params) => turns.push(params.turn));

		// Mock global fetch for LLM call
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								role: "assistant",
								content:
									"<tasks>- [x] Answer question</tasks><known>The user is asking about France.</known><unknown></unknown><summary>The capital of France is Paris.</summary>",
							},
						},
					],
					usage: { total_tokens: 50 },
				}),
			);

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

		// Find the turn that actually contains the summary
		const finalTurn = turns.find((t) => t.assistant.summary?.includes("Paris"));
		assert.ok(
			finalTurn,
			"Could not find a turn with the correct summary in notifications",
		);

		assert.ok(finalTurn.user.includes("France"));

		// Verify structured tasks
		assert.ok(
			Array.isArray(finalTurn.assistant.tasks),
			"Tasks should be an array",
		);
		assert.ok(
			finalTurn.assistant.tasks.length > 0,
			"Tasks should not be empty",
		);
		assert.strictEqual(finalTurn.assistant.tasks[0].completed, true);

		assert.ok(
			finalTurn.context.includes("<context"),
			"Context should be a prettified XML string",
		);
	});
});
