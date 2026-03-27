import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 180_000;

describe("E2E: Prefill Workflow (Option D)", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-prefill-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(
			join(projectPath, "config.js"),
			'const DB_HOST = "localhost";\nconst DB_PORT = 5432;\nmodule.exports = { DB_HOST, DB_PORT };\n',
		);
		await fs.writeFile(
			join(projectPath, "app.js"),
			'const express = require("express");\nconst app = express();\napp.listen(3000);\n',
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
			projectName: "PrefillProject",
			clientId: "c-prefill",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("ask with read tool should promote file and complete with 2+ turns", {
		timeout: TIMEOUT,
	}, async () => {
		const turns = [];
		client.on("run/step/completed", (params) => {
			turns.push(params);
		});

		const result = await client.call("ask", {
			model,
			prompt:
				"Read config.js to understand the database configuration. Then summarize what you found.",
		});

		assert.ok(
			["completed", "proposed"].includes(result.status),
			`Expected completed or proposed, got ${result.status}`,
		);

		// The model should have used read: config.js, causing the loop to continue.
		// We verify by checking that config.js appears in the feedback as "file retained".
		const allFeedback = turns.flatMap((t) => t.turn.feedback || []);
		const retained = allFeedback.find(
			(f) =>
				f.level === "info" &&
				f.target === "config.js" &&
				f.message.includes("retained"),
		);
		assert.ok(
			retained,
			`Expected feedback showing config.js was retained. All feedback: ${JSON.stringify(allFeedback)}`,
		);

		// If the loop continued (read processed → continue), we should have 2+ turn notifications
		assert.ok(
			turns.length >= 2,
			`Expected 2+ turns from read→continue→summary flow, got ${turns.length}`,
		);

		client.removeAllListeners("run/step/completed");
	});

	it("prefill should contain checked items from prior loop iteration", {
		timeout: TIMEOUT,
	}, async () => {
		const turns = [];
		client.on("run/step/completed", (params) => {
			turns.push(params);
		});

		const result = await client.call("ask", {
			model,
			prompt:
				"Read app.js to understand the server setup, then summarize what port the server listens on.",
		});

		assert.ok(
			["completed", "proposed"].includes(result.status),
			`Expected completed or proposed, got ${result.status}`,
		);

		// After the read is processed and loop continues, the second turn's
		// assistant content should include the checked read item from prefill.
		if (turns.length >= 2) {
			const secondTurn = turns[1].turn;
			const content = secondTurn.assistant.content || "";
			// The prefill would have injected "- [x] read: app.js" into the todo
			const hasPrefillEvidence =
				content.includes("[x] read:") || content.includes("[x] read ");
			assert.ok(
				hasPrefillEvidence,
				`Second turn should show prefill evidence (checked read item). Content starts with: ${content.slice(0, 300)}`,
			);
		}

		client.removeAllListeners("run/step/completed");
	});
});
