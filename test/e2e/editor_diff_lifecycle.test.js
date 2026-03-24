import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 180_000;

async function createIsolatedSession(files = {}) {
	const projectPath = join(tmpdir(), `rummy-edl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(projectPath, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		const dir = join(projectPath, name, "..");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(join(projectPath, name), content);
	}
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
		projectName: "EditorDiffTest",
		clientId: `c-${Date.now()}`,
	});
	for (const name of Object.keys(files)) {
		await client.call("activate", { pattern: name });
	}

	const cleanup = async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	};

	return { client, projectPath, cleanup };
}

/**
 * Collects editor/diff and run/step/completed notifications.
 */
function notificationCollector(client) {
	const diffs = [];
	const steps = [];
	client.on("editor/diff", (p) => diffs.push(p));
	client.on("run/step/completed", (p) => steps.push(p));

	const waitForDiffs = (count, timeoutMs = 60_000) =>
		new Promise((resolve, reject) => {
			if (diffs.length >= count) return resolve(diffs);
			const timer = setTimeout(() => reject(new Error(`Timeout: expected ${count} diffs, got ${diffs.length}`)), timeoutMs);
			const interval = setInterval(() => {
				if (diffs.length >= count) {
					clearTimeout(timer);
					clearInterval(interval);
					resolve(diffs);
				}
			}, 200);
		});

	const waitForStepAfter = (seq, runId, timeoutMs = 60_000) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout waiting for step after seq ${seq}`)), timeoutMs);
			const interval = setInterval(() => {
				const found = steps.find((s) => s.turn.sequence > seq && s.runId === runId);
				if (found) {
					clearTimeout(timer);
					clearInterval(interval);
					resolve(found);
				}
			}, 200);
		});

	const cleanup = () => {
		client.removeAllListeners("editor/diff");
		client.removeAllListeners("run/step/completed");
	};

	return { diffs, steps, waitForDiffs, waitForStepAfter, cleanup };
}

describe("E2E: editor/diff Lifecycle", () => {
	it("editor/diff notification should arrive with unified diff patch", { timeout: TIMEOUT }, async () => {
		const { client, cleanup: sessionCleanup } = await createIsolatedSession({
			"math.js": "function add(a, b) {\n\treturn a - b;\n}\nmodule.exports = { add };\n",
		});
		const { diffs, cleanup: notifCleanup, waitForDiffs } = notificationCollector(client);

		try {
			const result = await client.call("act", {
				model,
				prompt: "The add function in math.js subtracts instead of adding. Fix it.",
			});

			assert.strictEqual(result.status, "proposed", `Expected proposed, got ${result.status}`);

			await waitForDiffs(1);

			assert.ok(diffs.length > 0, "Should have received editor/diff notifications");

			const d = diffs[0];
			assert.ok(d.runId, "Should have runId");
			assert.ok(d.findingId, "Should have findingId");
			assert.strictEqual(d.type, "edit", "Should be an edit type");
			assert.ok(d.file.includes("math.js"), `File should be math.js, got ${d.file}`);
			assert.ok(d.patch.includes("---") && d.patch.includes("+++"), `Should be unified diff:\n${d.patch.slice(0, 300)}`);
			assert.ok(d.patch.includes("@@"), `Should have hunk headers:\n${d.patch.slice(0, 300)}`);
			assert.ok(d.patch.includes("-\treturn a - b;"), `Should show removed line:\n${d.patch}`);
			assert.ok(d.patch.includes("+\treturn a + b;"), `Should show added line:\n${d.patch}`);
			assert.strictEqual(d.error, null, "Should have no error");

			// Clean up findings
			for (const f of result.proposed) {
				await client.call("run/resolve", {
					runId: result.runId,
					resolution: { category: f.category, id: f.id, action: "accepted" },
				});
			}
		} finally {
			notifCleanup();
			await sessionCleanup();
		}
	});

	it("editor/diff findingId should match proposed finding id for run/resolve", { timeout: TIMEOUT }, async () => {
		const { client, cleanup: sessionCleanup } = await createIsolatedSession({
			"math.js": "function add(a, b) {\n\treturn a - b;\n}\nmodule.exports = { add };\n",
		});
		const { diffs, cleanup: notifCleanup, waitForDiffs } = notificationCollector(client);

		try {
			const result = await client.call("act", {
				model,
				prompt: "Fix the bug: add function subtracts. Change return a - b to return a + b.",
			});

			assert.strictEqual(result.status, "proposed");
			await waitForDiffs(1);

			// The findingId from editor/diff should match an id in the proposed array
			const diffNotif = diffs[0];
			const matchingProposed = result.proposed.find(
				(p) => p.category === "diff" && p.id === diffNotif.findingId,
			);
			assert.ok(
				matchingProposed,
				`editor/diff findingId ${diffNotif.findingId} should match a proposed finding. Proposed ids: ${result.proposed.map((p) => `${p.category}:${p.id}`).join(", ")}`,
			);

			// Resolve using the findingId from the notification
			const resolveResult = await client.call("run/resolve", {
				runId: result.runId,
				resolution: {
					category: "diff",
					id: diffNotif.findingId,
					action: "accepted",
				},
			});

			// If there are remaining findings, resolve those too
			if (resolveResult.status === "proposed") {
				for (const f of resolveResult.proposed) {
					await client.call("run/resolve", {
						runId: result.runId,
						resolution: { category: f.category, id: f.id, action: "accepted" },
					});
				}
			}
		} finally {
			notifCleanup();
			await sessionCleanup();
		}
	});

	it("accepted edit should produce <info file=...> in resumed turn context", { timeout: TIMEOUT }, async () => {
		const { client, cleanup: sessionCleanup } = await createIsolatedSession({
			"math.js": "function add(a, b) {\n\treturn a - b;\n}\nmodule.exports = { add };\n",
		});
		const { diffs, steps, cleanup: notifCleanup, waitForDiffs, waitForStepAfter } = notificationCollector(client);

		try {
			const result = await client.call("act", {
				model,
				prompt: "Fix the bug: add function subtracts. Change return a - b to return a + b.",
			});

			assert.strictEqual(result.status, "proposed");
			const proposingSeq = result.turn;

			// Accept all findings
			for (const f of result.proposed) {
				await client.call("run/resolve", {
					runId: result.runId,
					resolution: { category: f.category, id: f.id, action: "accepted" },
				});
			}

			// Wait for the auto-resumed turn
			const resumedStep = await waitForStepAfter(proposingSeq, result.runId);
			const ctx = resumedStep.turn.context;

			assert.ok(ctx, "Resumed turn should have context");
			assert.ok(
				ctx.includes("<info") && ctx.includes("file="),
				`Context should have <info file="..."> tag:\n${ctx.slice(0, 500)}`,
			);
			assert.ok(ctx.includes("accepted"), `Context should mention acceptance:\n${ctx.slice(0, 500)}`);
		} finally {
			notifCleanup();
			await sessionCleanup();
		}
	});

	it("rejected edit should produce <warn file=...> in resumed turn context", { timeout: TIMEOUT }, async () => {
		const { client, cleanup: sessionCleanup } = await createIsolatedSession({
			"math.js": "function add(a, b) {\n\treturn a - b;\n}\nmodule.exports = { add };\n",
		});
		const { cleanup: notifCleanup, waitForStepAfter } = notificationCollector(client);

		try {
			const result = await client.call("act", {
				model,
				prompt: "Fix the bug: add function subtracts. Change return a - b to return a + b.",
			});

			assert.strictEqual(result.status, "proposed");
			const proposingSeq = result.turn;

			// Reject all findings
			for (const f of result.proposed) {
				await client.call("run/resolve", {
					runId: result.runId,
					resolution: { category: f.category, id: f.id, action: "rejected" },
				});
			}

			const resumedStep = await waitForStepAfter(proposingSeq, result.runId);
			const ctx = resumedStep.turn.context;

			assert.ok(ctx, "Resumed turn should have context");
			assert.ok(
				ctx.includes("<warn") && ctx.includes("file="),
				`Context should have <warn file="..."> for rejection:\n${ctx.slice(0, 500)}`,
			);
			assert.ok(ctx.includes("rejected"), `Context should mention rejection:\n${ctx.slice(0, 500)}`);
		} finally {
			notifCleanup();
			await sessionCleanup();
		}
	});

	it("command finding should emit editor/diff-style notification and resolve with output", { timeout: TIMEOUT }, async () => {
		const { client, cleanup: sessionCleanup } = await createIsolatedSession({
			"package.json": JSON.stringify({ name: "test", version: "1.0.0", scripts: { test: "echo ok" } }, null, 2),
		});
		const { diffs, steps, cleanup: notifCleanup, waitForStepAfter } = notificationCollector(client);

		try {
			const result = await client.call("act", {
				model,
				prompt: 'Run "node --version" using an <env> tag. Do NOT edit any files.',
			});

			assert.strictEqual(result.status, "proposed", `Expected proposed, got ${result.status}`);
			const proposingSeq = result.turn;

			const cmdFinding = result.proposed.find((f) => f.category === "command");
			assert.ok(cmdFinding, `Should have a command finding. Got: ${result.proposed.map((f) => f.category).join(", ")}`);

			// Accept with simulated output
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

			const resumedStep = await waitForStepAfter(proposingSeq, result.runId);
			const ctx = resumedStep.turn.context;

			assert.ok(ctx.includes("command="), `Context should reference the command:\n${ctx.slice(0, 500)}`);
			assert.ok(ctx.includes("v25.0.0"), `Context should contain command output:\n${ctx.slice(0, 500)}`);
		} finally {
			notifCleanup();
			await sessionCleanup();
		}
	});
});
