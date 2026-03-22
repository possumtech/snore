import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E: Protocol Alignment & Stability", () => {
	let tdb, tserver, client;
	const projectPath = join(process.cwd(), "test_alignment_project");
	const iterations = process.env.STABILITY_ITERATIONS
		? parseInt(process.env.STABILITY_ITERATIONS, 10)
		: 1;
	let model = process.env.RUMMY_MODEL_DEFAULT || "opusqwen";
	if (model === "ccp") model = "opusqwen"; // Force opusqwen for this specific E2E

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
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

	it(`should maintain protocol alignment over ${iterations} iteration(s) using ${model}`, async () => {
		await client.call("init", {
			projectPath,
			projectName: "AlignmentProject",
			clientId: "alignment-test",
		});

		for (let i = 0; i < iterations; i++) {
			console.log(`  [STABILITY] Iteration ${i + 1}/${iterations}...`);

			const turns = [];
			client.on("run/step/completed", (payload) => turns.push(payload.turn));

			const result = await client.call("ask", {
				model,
				prompt: "What is the capital of France?",
			});
			assert.strictEqual(
				result.status,
				"completed",
				`Iteration ${i + 1} failed to complete.`,
			);

			// The final turn must have a summary and correct tags
			const finalTurn = turns[turns.length - 1];
			assert.ok(finalTurn.assistant.summary, "Final turn missing summary");
			assert.ok(
				Array.isArray(finalTurn.assistant.tasks),
				"Final turn missing structured tasks",
			);
			assert.ok(
				finalTurn.assistant.summary.includes("Paris"),
				"Incorrect answer in summary",
			);

			// Clean up listeners for next iteration
			client.removeAllListeners("run/step/completed");
		}
	});
});
