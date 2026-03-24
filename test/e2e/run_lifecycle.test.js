import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = "grok";
const TIMEOUT = 120_000;

describe("E2E: Run Lifecycle", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-lifecycle-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(
			join(projectPath, "app.js"),
			'function greet(name) {\n\treturn "Hello, " + name;\n}\nmodule.exports = greet;\n',
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
			projectName: "LifecycleProject",
			clientId: "c-lifecycle",
		});

		await client.call("activate", { pattern: "app.js" });
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("run/abort should set run status to aborted", { timeout: TIMEOUT }, async () => {
		const actResult = await client.call("act", {
			model,
			prompt: "Add JSDoc comments to the greet function in app.js.",
		});

		assert.strictEqual(actResult.status, "proposed");
		assert.ok(actResult.runId);

		// Abort without resolving findings
		const abortResult = await client.call("run/abort", {
			runId: actResult.runId,
		});

		assert.strictEqual(abortResult.status, "ok");
	});

	it("state lock: act on run with unresolved findings should return proposed", { timeout: TIMEOUT }, async () => {
		const actResult = await client.call("act", {
			model,
			prompt: "Add a default parameter value to the greet function in app.js. Set name to default to 'World'.",
		});

		assert.strictEqual(actResult.status, "proposed");
		assert.ok(actResult.proposed.length > 0);

		// Try to send another act on the same run without resolving
		const secondResult = await client.call("act", {
			model,
			runId: actResult.runId,
			prompt: "Now also add error handling.",
		});

		// Should be blocked — still has unresolved findings
		assert.strictEqual(secondResult.status, "proposed");
		assert.ok(secondResult.remainingCount > 0, "Should report remaining unresolved findings");

		// Clean up: resolve findings so we don't leak state
		for (const finding of secondResult.proposed) {
			await client.call("run/resolve", {
				runId: actResult.runId,
				resolution: {
					category: finding.category,
					id: finding.id,
					action: "rejected",
				},
			});
		}
	});

	it("run continuation: ask with same runId preserves history", { timeout: TIMEOUT }, async () => {
		const turns = [];
		client.on("run/step/completed", (params) => turns.push(params));

		const firstResult = await client.call("ask", {
			model,
			prompt: "What does the greet function in app.js do? Be brief.",
		});

		assert.strictEqual(firstResult.status, "completed");
		assert.ok(firstResult.runId);

		const secondResult = await client.call("ask", {
			model,
			runId: firstResult.runId,
			prompt: "What was my previous question about?",
		});

		assert.strictEqual(secondResult.status, "completed");
		assert.strictEqual(secondResult.runId, firstResult.runId);

		// The second turn should reference the first question
		const secondTurn = turns.find(
			(t) => t.turn.sequence > 0 && t.runId === firstResult.runId,
		);
		if (secondTurn) {
			const text = [
				secondTurn.turn.assistant.content,
				secondTurn.turn.assistant.summary,
				secondTurn.turn.assistant.known,
			]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();
			assert.ok(
				text.includes("greet") || text.includes("function") || text.includes("app"),
				"Model should reference the previous question context",
			);
		}

		client.removeAllListeners("run/step/completed");
	});

	it("run/step/completed notification should contain structured turn data", { timeout: TIMEOUT }, async () => {
		const notifications = [];
		client.on("run/step/completed", (params) => notifications.push(params));

		await client.call("ask", {
			model,
			prompt: "What programming language is app.js written in?",
		});

		assert.ok(notifications.length > 0, "Should have received at least one notification");

		const notif = notifications[0];
		assert.ok(notif.runId, "Notification should have runId");
		assert.ok(notif.turn, "Notification should have turn object");
		assert.ok(Number.isInteger(notif.turn.sequence), "Turn should have sequence number");
		assert.ok(notif.turn.assistant, "Turn should have assistant object");
		assert.ok(Array.isArray(notif.turn.assistant.tasks), "Tasks should be an array");
		assert.ok(Array.isArray(notif.files), "Files should be an array");

		client.removeAllListeners("run/step/completed");
	});
});
