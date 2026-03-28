import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 60_000;

describe("E2E: Foundation — Happy Path Contract", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-foundation-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(
			join(projectPath, "hello.js"),
			"function greet() { return 'hello'; }\nmodule.exports = greet;\n",
		);
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
		await client.call("init", {
			projectPath,
			projectName: "FoundationTest",
			clientId: "c-foundation",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("ask should return valid structured JSON with summary", {
		timeout: TIMEOUT,
	}, async () => {
		const turns = [];
		client.on("run/step/completed", (p) => turns.push(p));

		const result = await client.call("ask", {
			model,
			prompt: "What is the capital of France?",
		});

		assert.strictEqual(
			result.status,
			"completed",
			`Expected completed, got ${result.status}`,
		);
		assert.ok(turns.length > 0, "Should have received turn notifications");

		const turn = turns.at(-1).turn;
		assert.ok(Array.isArray(turn.assistant.todo), "todo should be an array");
		assert.ok(Array.isArray(turn.assistant.known), "known should be an array");
		assert.ok(
			Array.isArray(turn.assistant.unknown),
			"unknown should be an array",
		);
		assert.ok(
			typeof turn.assistant.summary === "string",
			"summary should be a string",
		);
		assert.ok(
			turn.assistant.summary.toLowerCase().includes("paris"),
			`Summary should contain the answer. Got: ${turn.assistant.summary}`,
		);

		client.removeAllListeners("run/step/completed");
	});

	it("ask with noContext should return valid structured JSON", {
		timeout: TIMEOUT,
	}, async () => {
		const turns = [];
		client.on("run/step/completed", (p) => turns.push(p));

		const result = await client.call("ask", {
			model,
			prompt: "What is 7 * 8?",
			noContext: true,
		});

		assert.strictEqual(
			result.status,
			"completed",
			`Expected completed, got ${result.status}`,
		);
		assert.ok(turns.length > 0, "Should have received turn notifications");

		const turn = turns.at(-1).turn;
		assert.ok(Array.isArray(turn.assistant.todo), "todo should be an array");
		assert.ok(
			typeof turn.assistant.summary === "string",
			"summary should be a string",
		);
		assert.ok(
			turn.assistant.summary.includes("56"),
			`Summary should contain 56. Got: ${turn.assistant.summary}`,
		);

		client.removeAllListeners("run/step/completed");
	});

	it("act with edit should propose a diff for an existing file", {
		timeout: TIMEOUT,
	}, async () => {
		await client.call("activate", { pattern: "hello.js" });

		const result = await client.call("act", {
			model,
			prompt:
				"Change the greet function in hello.js to return 'goodbye' instead of 'hello'.",
		});

		assert.strictEqual(
			result.status,
			"proposed",
			`Expected proposed (model should produce an edit), got ${result.status}`,
		);
		assert.ok(result.proposed.length > 0, "Should have proposed findings");

		const diff = result.proposed.find((f) => f.category === "diff");
		assert.ok(diff, "Should have a diff finding");
		assert.ok(diff.patch, "Diff should have a patch");
		assert.ok(diff.patch.includes("goodbye"), "Patch should contain 'goodbye'");

		// Clean up — accept the diff
		for (const f of result.proposed) {
			await client.call("run/resolve", {
				runId: result.runId,
				resolution: { category: f.category, id: f.id, action: "accepted" },
			});
		}
	});

	it("act with edit should create a new file that does not exist", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("act", {
			model,
			prompt:
				'Create a new file called "HELLO.md" with the content "# Hello World".',
		});

		assert.strictEqual(
			result.status,
			"proposed",
			`Expected proposed (new file creation), got ${result.status}`,
		);
		assert.ok(result.proposed.length > 0, "Should have proposed findings");

		const diff = result.proposed.find((f) => f.category === "diff");
		assert.ok(diff, "Should have a diff finding");
		assert.ok(diff.patch, "Diff should have a patch");
		assert.ok(
			diff.patch.includes("Hello"),
			`Patch should contain file content. Got: ${diff.patch?.substring(0, 200)}`,
		);

		// Clean up
		for (const f of result.proposed) {
			await client.call("run/resolve", {
				runId: result.runId,
				resolution: { category: f.category, id: f.id, action: "rejected" },
			});
		}
	});

	it("ask with read should retain file and not loop on redundant reads", {
		timeout: TIMEOUT,
	}, async () => {
		const turns = [];
		client.on("run/step/completed", (p) => turns.push(p));

		const result = await client.call("ask", {
			model,
			prompt: "Read hello.js and tell me what the greet function returns.",
		});

		assert.ok(
			["completed", "proposed"].includes(result.status),
			`Expected completed or proposed, got ${result.status}`,
		);

		// The model should read hello.js (1 new read), get the file in context,
		// then answer. Should NOT loop forever re-reading.
		assert.ok(
			turns.length <= 5,
			`Expected at most 5 turns (read → answer). Got ${turns.length} turns — possible redundant read loop.`,
		);

		// Check that the file was retained
		const allFeedback = turns.flatMap((t) => t.turn.feedback || []);
		const retained = allFeedback.find(
			(f) => f.target === "hello.js" && f.message.includes("retained"),
		);
		assert.ok(retained, "hello.js should have been retained");

		client.removeAllListeners("run/step/completed");
	});
});
