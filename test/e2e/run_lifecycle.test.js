import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 120_000;

async function createIsolatedSession() {
	const projectPath = join(tmpdir(), `rummy-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	const tdb = await TestDb.create();
	const tserver = await TestServer.start(tdb.db);
	const client = new RpcClient(tserver.url);
	await client.connect();
	await client.call("init", {
		projectPath,
		projectName: "LifecycleProject",
		clientId: `c-${Date.now()}`,
	});
	await client.call("activate", { pattern: "app.js" });

	const cleanup = async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	};

	return { client, cleanup };
}

describe("E2E: Run Lifecycle", () => {
	it("run/abort should set run status to aborted", { timeout: TIMEOUT }, async () => {
		const { client, cleanup } = await createIsolatedSession();
		try {
			const actResult = await client.call("act", {
				model,
				prompt: "Edit app.js: add JSDoc comments above the greet function. Use an <edit> tag with SEARCH/REPLACE.",
			});

			assert.strictEqual(
				actResult.status, "proposed",
				"Model completed instead of proposing. Non-deterministic — re-run the test.",
			);
			assert.ok(actResult.runId);

			const abortResult = await client.call("run/abort", {
				runId: actResult.runId,
			});

			assert.strictEqual(abortResult.status, "ok");
		} finally {
			await cleanup();
		}
	});

	it("state lock: act on run with unresolved findings should return proposed", { timeout: TIMEOUT }, async () => {
		const { client, cleanup } = await createIsolatedSession();
		try {
			const actResult = await client.call("act", {
				model,
				prompt: "Edit app.js: add a default parameter value to the greet function. Set name to default to 'World'. Use an <edit> tag with SEARCH/REPLACE.",
			});

			assert.strictEqual(
				actResult.status, "proposed",
				"Model completed instead of proposing. Non-deterministic — re-run the test.",
			);
			assert.ok(actResult.proposed.length > 0);

			// Try to send another act on the same run without resolving
			const secondResult = await client.call("act", {
				model,
				runId: actResult.runId,
				prompt: "Now also add error handling.",
			});

			assert.strictEqual(secondResult.status, "proposed");
			assert.ok(secondResult.remainingCount > 0, "Should report remaining unresolved findings");

			// Clean up
			for (const finding of secondResult.proposed) {
				await client.call("run/resolve", {
					runId: actResult.runId,
					resolution: { category: finding.category, id: finding.id, action: "rejected" },
				});
			}
		} finally {
			await cleanup();
		}
	});

	it("run continuation: ask with same runId preserves history", { timeout: TIMEOUT }, async () => {
		const { client, cleanup } = await createIsolatedSession();
		try {
			const turns = [];
			client.on("run/step/completed", (params) => turns.push(params));

			const firstResult = await client.call("ask", {
				model,
				prompt: "What does the greet function in app.js do? Be brief.",
			});

			assert.ok(
				["completed", "proposed"].includes(firstResult.status),
				`First ask should complete or propose, got ${firstResult.status}`,
			);
			assert.ok(firstResult.runId);

			if (firstResult.status === "proposed") {
				for (const f of firstResult.proposed) {
					await client.call("run/resolve", {
						runId: firstResult.runId,
						resolution: { category: f.category, id: f.id, action: "accepted", output: "(ok)", isError: false },
					});
				}
			}

			const secondResult = await client.call("ask", {
				model,
				runId: firstResult.runId,
				prompt: "What was my previous question about?",
			});

			assert.ok(
				["completed", "proposed"].includes(secondResult.status),
				`Second ask should complete or propose, got ${secondResult.status}`,
			);
			assert.strictEqual(secondResult.runId, firstResult.runId);

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
		} finally {
			await cleanup();
		}
	});

	it("run/step/completed notification should contain structured turn data", { timeout: TIMEOUT }, async () => {
		const { client, cleanup } = await createIsolatedSession();
		try {
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
			assert.ok(Array.isArray(notif.turn.assistant.todo), "Todo should be an array");
			assert.ok(Array.isArray(notif.files), "Files should be an array");

			client.removeAllListeners("run/step/completed");
		} finally {
			await cleanup();
		}
	});
});
