import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 120_000;

describe("E2E: Command Resolution", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-cmd-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(
			join(projectPath, "package.json"),
			JSON.stringify(
				{
					name: "test-project",
					version: "1.0.0",
					scripts: { test: "echo ok" },
				},
				null,
				2,
			),
		);
		await fs.writeFile(
			join(projectPath, "index.js"),
			"export default function hello() { return 42; }\n",
		);

		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "test@test.com" && git config user.name "Test" && git add . && git commit --no-verify -m "feat: init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();

		await client.call("init", {
			projectPath,
			projectName: "CmdProject",
			clientId: "c-cmd",
		});

		await client.call("activate", { pattern: "*" });
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("model should emit command findings that appear as proposed", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("act", {
			model,
			prompt:
				'I need you to check the Node.js version on this machine. Use an <env> tag to run "node --version". Do NOT edit any files.',
		});

		assert.strictEqual(
			result.status,
			"proposed",
			`Expected proposed, got ${result.status}`,
		);
		assert.ok(result.proposed.length > 0, "Should have proposed findings");

		const cmd = result.proposed.find((f) => f.category === "command");
		assert.ok(
			cmd,
			`Should have a command finding. Got categories: ${result.proposed.map((f) => f.category).join(", ")}`,
		);
		assert.strictEqual(cmd.status, "proposed");
		assert.ok(
			cmd.patch.includes("node") || cmd.patch.includes("version"),
			`Command should reference node version. Got: ${cmd.patch}`,
		);

		// Clean up
		for (const f of result.proposed) {
			await client.call("run/resolve", {
				runId: result.runId,
				resolution: {
					category: f.category,
					id: f.id,
					action: "accepted",
					output: f.category === "command" ? "v25.0.0" : undefined,
					isError: false,
				},
			});
		}
	});

	it("accepted command with output should produce <info command=...> in resumed turn context", {
		timeout: TIMEOUT,
	}, async () => {
		const turns = new Map();
		client.on("run/step/completed", (params) => {
			turns.set(params.turn.sequence, params);
		});

		const actResult = await client.call("act", {
			model,
			prompt:
				'Run "node --version" using an <env> tag to check what Node.js version is installed. Do NOT edit any files.',
		});

		assert.strictEqual(
			actResult.status,
			"proposed",
			`Expected proposed, got ${actResult.status}`,
		);
		const proposingSeq = actResult.turn;

		// Accept the command with simulated output
		for (const f of actResult.proposed) {
			await client.call("run/resolve", {
				runId: actResult.runId,
				resolution: {
					category: f.category,
					id: f.id,
					action: "accepted",
					output: f.category === "command" ? "v25.0.0" : undefined,
					isError: false,
				},
			});
		}

		// Wait for the resumed turn
		const startTime = Date.now();
		let resumedTurn = null;
		while (Date.now() - startTime < 60_000) {
			for (const [seq, payload] of turns) {
				if (seq > proposingSeq && payload.runId === actResult.runId) {
					resumedTurn = payload;
					break;
				}
			}
			if (resumedTurn) break;
			await new Promise((r) => setTimeout(r, 500));
		}

		assert.ok(resumedTurn, "Should have received a resumed turn notification");

		const ctx = resumedTurn.turn.context;
		assert.ok(ctx, "Resumed turn should have context");
		assert.ok(
			ctx.includes("<info") && ctx.includes("command="),
			`Context should contain <info command="..."> tag. Context:\n${ctx.slice(0, 500)}`,
		);
		assert.ok(
			ctx.includes("v25.0.0"),
			`Context should contain the command output "v25.0.0". Context:\n${ctx.slice(0, 500)}`,
		);

		client.removeAllListeners("run/step/completed");
	});

	it("accepted command with error should produce <error command=...> in resumed turn context", {
		timeout: TIMEOUT,
	}, async () => {
		const turns = new Map();
		client.on("run/step/completed", (params) => {
			turns.set(params.turn.sequence, params);
		});

		const actResult = await client.call("act", {
			model,
			prompt:
				'Use a <run> tag to execute "npm test" in the project. Do NOT edit any files.',
		});

		assert.strictEqual(
			actResult.status,
			"proposed",
			`Expected proposed, got ${actResult.status}`,
		);
		const proposingSeq = actResult.turn;

		// Accept with error output — simulating a failed command
		for (const f of actResult.proposed) {
			await client.call("run/resolve", {
				runId: actResult.runId,
				resolution: {
					category: f.category,
					id: f.id,
					action: "accepted",
					output:
						f.category === "command"
							? "Error: test suite failed with 3 failures"
							: undefined,
					isError: f.category === "command",
				},
			});
		}

		const startTime = Date.now();
		let resumedTurn = null;
		while (Date.now() - startTime < 60_000) {
			for (const [seq, payload] of turns) {
				if (seq > proposingSeq && payload.runId === actResult.runId) {
					resumedTurn = payload;
					break;
				}
			}
			if (resumedTurn) break;
			await new Promise((r) => setTimeout(r, 500));
		}

		assert.ok(resumedTurn, "Should have received a resumed turn notification");

		const ctx = resumedTurn.turn.context;
		assert.ok(ctx, "Resumed turn should have context");
		assert.ok(
			ctx.includes("<error") && ctx.includes("command="),
			`Context should contain <error command="..."> tag for failed command. Context:\n${ctx.slice(0, 500)}`,
		);
		assert.ok(
			ctx.includes("test suite failed"),
			`Context should contain the error output. Context:\n${ctx.slice(0, 500)}`,
		);

		client.removeAllListeners("run/step/completed");
	});

	it("rejected command should not produce output in context", {
		timeout: TIMEOUT,
	}, async () => {
		const turns = new Map();
		client.on("run/step/completed", (params) => {
			turns.set(params.turn.sequence, params);
		});

		const actResult = await client.call("act", {
			model,
			prompt: 'Use an <env> tag to run "ls -la". Do NOT edit any files.',
		});

		assert.strictEqual(
			actResult.status,
			"proposed",
			`Expected proposed, got ${actResult.status}`,
		);
		const proposingSeq = actResult.turn;

		// Reject the command — no output, no execution
		for (const f of actResult.proposed) {
			await client.call("run/resolve", {
				runId: actResult.runId,
				resolution: {
					category: f.category,
					id: f.id,
					action: "rejected",
				},
			});
		}

		const startTime = Date.now();
		let resumedTurn = null;
		while (Date.now() - startTime < 60_000) {
			for (const [seq, payload] of turns) {
				if (seq > proposingSeq && payload.runId === actResult.runId) {
					resumedTurn = payload;
					break;
				}
			}
			if (resumedTurn) break;
			await new Promise((r) => setTimeout(r, 500));
		}

		assert.ok(resumedTurn, "Should have received a resumed turn notification");

		const ctx = resumedTurn.turn.context;
		assert.ok(ctx, "Resumed turn should have context");

		// For rejected commands, the pending_context still gets an entry with "rejected" as output
		// The model should see that the command was rejected
		assert.ok(
			ctx.includes("command="),
			`Context should still reference the command. Context:\n${ctx.slice(0, 500)}`,
		);
		assert.ok(
			ctx.includes("rejected"),
			`Context should indicate rejection. Context:\n${ctx.slice(0, 500)}`,
		);

		client.removeAllListeners("run/step/completed");
	});
});
