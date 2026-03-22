import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E: Protocol Error & Context Delivery", () => {
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

	it("should emit a turn with <error> in context when model violates protocol", async () => {
		const responses = [
			// Turn 0: Model fails (no tasks tag)
			"<known>Fact</known><unknown/><summary>Done</summary>",
			// Turn 1: Model recovers
			"<tasks>- [x] Answer</tasks><known>Fact</known><unknown/><summary>Done</summary>",
		];

		let responseIdx = 0;
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: { role: "assistant", content: responses[responseIdx++] },
						},
					],
				}),
			);

		const turns = [];
		client.on("run/step/completed", (params) => {
			console.log(
				`  [TEST DEBUG] Received turn notification. Errors: ${params.turn.errors.length}`,
			);
			turns.push(params.turn);
		});

		const clientId = `c-err-${Date.now()}`;
		await client.call("init", {
			projectPath: process.cwd(),
			projectName: "ErrProj",
			clientId,
		});
		const result = await client.call("ask", { model: "m1", prompt: "Go" });

		assert.strictEqual(result.status, "completed");

		assert.ok(
			turns.length >= 2,
			`Expected at least 2 turns, got ${turns.length}`,
		);

		// The first turn emitted should have the error in the errors array
		const failedTurn = turns[0];
		assert.ok(
			failedTurn.errors.length > 0,
			"First emitted turn should have structured errors",
		);
		assert.ok(
			failedTurn.errors[0].content.includes("Missing required tag"),
			"Error content mismatch",
		);

		// The second turn emitted (the recovery) should have the error in its context string
		// because TurnBuilder injected it from the feedback object.
		const recoveryTurn = turns[1];
		assert.ok(
			recoveryTurn.context.includes("<error"),
			"Error should be preserved in recovery turn context",
		);
	});
});
