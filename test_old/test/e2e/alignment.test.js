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
	const model = process.env.RUMMY_MODEL_DEFAULT;

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
			let resolveFinal;
			const finalTurnCaptured = new Promise((resolve, reject) => {
				resolveFinal = resolve;
				setTimeout(
					() => reject(new Error("Timeout waiting for final turn")),
					60000,
				);
			});

			client.on("run/step/completed", (payload) => {
				turns.push(payload.turn);
				resolveFinal();
			});

			const result = await client.call("ask", {
				model,
				prompt: "What is the capital of France?",
			});
			assert.strictEqual(
				result.status,
				"completed",
				`Iteration ${i + 1} failed to complete. Status: ${result.status}`,
			);

			await finalTurnCaptured;

			const finalTurn = turns[turns.length - 1];
			assert.ok(
				Array.isArray(finalTurn.assistant.todo),
				"Final turn missing structured todo",
			);
			const answer = [
				finalTurn.assistant.summary,
				finalTurn.assistant.known,
				finalTurn.assistant.content,
			]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();
			assert.ok(
				answer.includes("paris"),
				"Model did not identify Paris as the capital of France",
			);

			client.removeAllListeners("run/step/completed");
		}
	});
});
