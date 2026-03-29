import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E: Reasoning Content Normalization", () => {
	let tdb, tserver, client;
	const model = process.env.RUMMY_MODEL_DEFAULT;

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

	it("should capture reasoning from the real local model", async () => {
		const turnMap = new Map();
		client.on("run/step/completed", (params) => {
			turnMap.set(params.turn.sequence, params.turn);
		});

		await client.call("init", {
			projectPath: process.cwd(),
			projectName: "ReasonProj",
			clientId: "c-reason",
		});

		await client.call("ask", {
			model,
			prompt: "Think step by step about the meaning of life.",
		});

		const start = Date.now();
		while (turnMap.size === 0 && Date.now() - start < 30000) {
			await new Promise((r) => setTimeout(r, 500));
		}

		assert.ok(turnMap.has(0), "Turn 0 not captured");
		const turn = turnMap.get(0);
		assert.ok(
			Object.hasOwn(turn.assistant, "reasoning_content"),
			"Assistant object should have reasoning_content property",
		);
	});
});
