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
	const projectPath = join(tmpdir(), `rummy_decay_test_${Date.now()}`);

	before(async () => {
		process.env.RUMMY_DECAY_THRESHOLD = "2";
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(
			join(projectPath, "logic.js"),
			"function target() { return 'core logic'; }",
		);

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
		delete process.env.RUMMY_DECAY_THRESHOLD;
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("should empirically prove fidelity decay over turns", async () => {
		const turnResults = [];
		client.on("run/step/completed", (params) => {
			const turn = params.turn;
			turn.files = params.files;
			turnResults.push(turn);
		});

		// 0. Init
		await client.call("init", {
			projectPath,
			projectName: "FinalDecayV2",
			clientId: "c1",
		});

		const responses = [
			// Turn 0: Model says <read>.
			'<tasks>- [x] read</tasks><read file="logic.js"/>',
			// Turn 1: Model mentions file. last_attention = 1.
			"<tasks>- [ ] work</tasks><reasoning_content>Using logic.js</reasoning_content>",
			// Turn 2: Idle
			"<tasks>- [ ] idle</tasks>",
			// Turn 3: Idle
			"<tasks>- [ ] idle</tasks>",
			// Turn 4: SHOULD DECAY
			"<tasks>- [ ] idle</tasks><summary>Done</summary>",
		];

		let responseIdx = 0;
		globalThis.fetch = async () => {
			const content = responses[responseIdx++] || "<summary>Done</summary>";
			return new Response(
				JSON.stringify({
					choices: [{ message: { role: "assistant", content } }],
					usage: { total_tokens: 10 },
				}),
			);
		};

		const res1 = await client.call("ask", { prompt: "Go" });
		const runId = res1.runId;

		for (let i = 0; i < 4; i++) {
			await client.call("ask", { prompt: "Continue", runId });
		}

		const findTurn = (seq) => turnResults.find((t) => t.sequence === seq);

		// Verified Turn Sequences:
		assert.ok(
			!findTurn(0).context.includes("<source>"),
			"Turn 0: Summary only",
		);
		assert.ok(
			findTurn(1).context.includes("<source>"),
			"Turn 1: Source present (after read)",
		);
		assert.strictEqual(
			findTurn(1).files.find((f) => f.path === "logic.js").state,
			"retained",
			"Turn 1: State should be 'retained'",
		);
		assert.ok(
			findTurn(2).context.includes("<source>"),
			"Turn 2: Source present (within window)",
		);
		assert.ok(
			findTurn(3).context.includes("<source>"),
			"Turn 3: Source present (Retained & Recent)",
		);
		assert.ok(
			!findTurn(4).context.includes("<source>"),
			"Turn 4: Source DECAYED (Retained & Old)",
		);
	});
});
