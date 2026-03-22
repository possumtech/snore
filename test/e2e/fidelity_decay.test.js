import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E: Context Fidelity Decay (Corrected Protocol)", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-decay-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "logic.js"), "function init() {}");
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

	it("should empirically prove fidelity decay over turns", async () => {
		const turns = [];
		client.on("run/step/completed", (payload) => turns.push(payload.turn));

		const clientId = `c-decay-${Date.now()}`;
		await client.call("init", {
			projectPath,
			projectName: "DecayProject",
			clientId,
		});

		const responses = [
			// Turn 0: Model says <read>.
			'<tasks>- [x] read</tasks><known>G</known><unknown/><read file="logic.js"/>',
			// Turn 1: Model mentions file. last_attention = 1.
			"<tasks>- [ ] work</tasks><known>G</known><unknown/><reasoning_content>Using logic.js</reasoning_content>",
			// Turn 2: Idle
			"<tasks>- [ ] idle</tasks><known>G</known><unknown/>",
			// Turn 3: Idle
			"<tasks>- [ ] idle</tasks><known>G</known><unknown/>",
			// Turn 4: SHOULD DECAY
			"<tasks>- [ ] idle</tasks><known>G</known><unknown/><summary>Done</summary>",
		];

		let responseIdx = 0;
		globalThis.fetch = async () => {
			const content =
				responses[responseIdx++] ||
				"<tasks>T</tasks><known>K</known><unknown/><summary>Done</summary>";
			return new Response(
				JSON.stringify({
					choices: [{ message: { role: "assistant", content } }],
					usage: { total_tokens: 10 },
				}),
			);
		};

		// Force threshold to 2 turns for testing
		process.env.RUMMY_DECAY_THRESHOLD = "2";

		const result = await client.call("ask", {
			model: "ccp",
			prompt: "Let's begin.",
		});

		assert.strictEqual(result.status, "completed");

		const findTurn = (seq) => turns.find((t) => t.sequence === seq);

		assert.ok(
			findTurn(0).context.includes("logic.js"),
			"Turn 0: logic.js in map",
		);
		assert.ok(
			findTurn(1).context.includes("<source>"),
			"Turn 1: Source present (Recently mentioned)",
		);
		assert.ok(
			findTurn(2).context.includes("<source>"),
			"Turn 2: Source present (Recent enough)",
		);
		assert.ok(
			findTurn(3).context.includes("<source>"),
			"Turn 3: Source present (Recent enough)",
		);
		assert.ok(
			!findTurn(4).context.includes("<source>"),
			"Turn 4: Source DECAYED (Threshold reached)",
		);
	});
});
