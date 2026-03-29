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
	const projectPath = join(
		tmpdir(),
		`rummy-modes-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
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
		projectName: "ModesProject",
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

describe("E2E: Run Modes", () => {
	describe("Lite Mode (noContext)", () => {
		it("ask with noContext should complete without file listings in context", {
			timeout: TIMEOUT,
		}, async () => {
			const { client, cleanup } = await createIsolatedSession();
			try {
				const notifications = [];
				client.on("run/step/completed", (params) => notifications.push(params));

				const result = await client.call("ask", {
					model,
					noContext: true,
					prompt: "What is 2+2? Reply with just the number.",
				});

				assert.ok(
					["completed", "proposed"].includes(result.status),
					`Expected completed or proposed, got ${result.status}`,
				);
				assert.ok(result.run, "Should have a run");

				assert.ok(
					notifications.length > 0,
					"Should have received at least one notification",
				);

				const turn = notifications[0].turn;
				const context = turn.context || "";
				assert.ok(
					!context.includes("<file"),
					"Lite mode context should not contain file listings",
				);

				const text = [turn.assistant.content, turn.assistant.summary]
					.filter(Boolean)
					.join(" ");
				assert.ok(text.includes("4"), "Model should answer 2+2 = 4");

				client.removeAllListeners("run/step/completed");
			} finally {
				await cleanup();
			}
		});

		it("act with noContext should still be able to propose findings", {
			timeout: TIMEOUT,
		}, async () => {
			const { client, cleanup } = await createIsolatedSession();
			try {
				const notifications = [];
				client.on("run/step/completed", (params) => notifications.push(params));

				const result = await client.call("act", {
					model,
					noContext: true,
					prompt:
						"Edit app.js: add a comment at the top of the file saying '// entry point'. Put the change in the edits array.",
				});

				assert.ok(
					["completed", "proposed"].includes(result.status),
					`Expected completed or proposed, got ${result.status}`,
				);
				assert.ok(result.run, "Should have a run");

				assert.ok(
					notifications.length > 0,
					"Should have received at least one notification",
				);

				const turn = notifications[0].turn;
				const context = turn.context || "";
				assert.ok(
					!context.includes("<file"),
					"Lite mode context should not contain file listings",
				);

				client.removeAllListeners("run/step/completed");
			} finally {
				await cleanup();
			}
		});
	});

	describe("Fork Mode", () => {
		it("fork should create new run with history from parent", {
			timeout: TIMEOUT,
		}, async () => {
			const { client, cleanup } = await createIsolatedSession();
			try {
				const firstResult = await client.call("ask", {
					model,
					prompt: "What is 2+2? Reply with just the number.",
				});

				assert.ok(
					["completed", "proposed"].includes(firstResult.status),
					`First ask should complete or propose, got ${firstResult.status}`,
				);
				assert.ok(firstResult.run, "First ask should have a run");

				if (firstResult.status === "proposed") {
					for (const f of firstResult.proposed) {
						await client.call("run/resolve", {
							run: firstResult.run,
							resolution: {
								category: f.category,
								id: f.id,
								action: "accepted",
								output: "(ok)",
								isError: false,
							},
						});
					}
				}

				const notifications = [];
				client.on("run/step/completed", (params) => notifications.push(params));

				const forkResult = await client.call("ask", {
					model,
					run: firstResult.run,
					fork: true,
					prompt: "What was my previous question about? Be brief.",
				});

				assert.ok(
					["completed", "proposed"].includes(forkResult.status),
					`Fork ask should complete or propose, got ${forkResult.status}`,
				);
				assert.ok(forkResult.run, "Fork should have a run");
				assert.notStrictEqual(
					forkResult.run,
					firstResult.run,
					"Forked run should have a DIFFERENT run than the parent",
				);

				const forkTurn = notifications.find((n) => n.run === forkResult.run);
				if (forkTurn) {
					const text = [
						forkTurn.turn.assistant.content,
						forkTurn.turn.assistant.summary,
						forkTurn.turn.assistant.known,
					]
						.filter(Boolean)
						.join(" ")
						.toLowerCase();
					assert.ok(
						text.includes("2") ||
							text.includes("math") ||
							text.includes("addition") ||
							text.includes("sum") ||
							text.includes("plus"),
						"Model should reference the original question (proving history was inherited)",
					);
				}

				client.removeAllListeners("run/step/completed");
			} finally {
				await cleanup();
			}
		});

		it("fork should not affect parent run", { timeout: TIMEOUT }, async () => {
			const { client, cleanup } = await createIsolatedSession();
			try {
				const firstResult = await client.call("ask", {
					model,
					prompt: "What is 2+2? Reply with just the number.",
				});

				assert.ok(
					["completed", "proposed"].includes(firstResult.status),
					`First ask should complete or propose, got ${firstResult.status}`,
				);
				const parentRun = firstResult.run;

				if (firstResult.status === "proposed") {
					for (const f of firstResult.proposed) {
						await client.call("run/resolve", {
							run: parentRun,
							resolution: {
								category: f.category,
								id: f.id,
								action: "accepted",
								output: "(ok)",
								isError: false,
							},
						});
					}
				}

				const forkResult = await client.call("ask", {
					model,
					run: parentRun,
					fork: true,
					prompt: "Say hello.",
				});

				assert.ok(forkResult.run, "Fork should have a run");
				assert.notStrictEqual(
					forkResult.run,
					parentRun,
					"Fork should create a new run",
				);

				// Parent run should still be usable — continue it independently
				const parentNotifications = [];
				client.on("run/step/completed", (params) => {
					if (params.run === parentRun) parentNotifications.push(params);
				});

				const continueResult = await client.call("ask", {
					model,
					run: parentRun,
					prompt: "What is 3+3? Reply with just the number.",
				});

				assert.ok(
					["completed", "proposed"].includes(continueResult.status),
					`Continuing parent should complete or propose, got ${continueResult.status}`,
				);
				assert.strictEqual(
					continueResult.run,
					parentRun,
					"Continuing parent run should keep the same run",
				);

				if (parentNotifications.length > 0) {
					const text = [
						parentNotifications[0].turn.assistant.content,
						parentNotifications[0].turn.assistant.summary,
					]
						.filter(Boolean)
						.join(" ");
					assert.ok(
						text.includes("6"),
						"Parent run should independently answer 3+3 = 6",
					);
				}

				client.removeAllListeners("run/step/completed");
			} finally {
				await cleanup();
			}
		});
	});
});
