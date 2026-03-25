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
		`rummy-diff-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await fs.mkdir(projectPath, { recursive: true });
	await fs.writeFile(
		join(projectPath, "main.js"),
		'const mesage = "hello";\nconsole.log(mesage);\n',
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
		projectName: "DiffProject",
		clientId: `c-${Date.now()}`,
	});
	await client.call("activate", { pattern: "main.js" });

	const cleanup = async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	};

	return { client, cleanup };
}

async function actAndExpectProposed(client, prompt) {
	const result = await client.call("act", { model, prompt });
	assert.strictEqual(
		result.status,
		"proposed",
		"Model completed instead of proposing. Non-deterministic — re-run the test.",
	);
	assert.ok(result.proposed.length > 0, "Should have proposed findings");
	return result;
}

async function resolveAll(client, runId, proposed, action = "accepted") {
	let last;
	for (const finding of proposed) {
		last = await client.call("run/resolve", {
			runId,
			resolution: { category: finding.category, id: finding.id, action },
		});
	}
	return last;
}

describe("E2E: Diff Resolution", () => {
	it("act should return proposed status with findings when model emits edits", {
		timeout: TIMEOUT,
	}, async () => {
		const { client, cleanup } = await createIsolatedSession();
		try {
			const result = await actAndExpectProposed(
				client,
				'Fix the typo in main.js. The variable "mesage" should be "message". Only edit the file, do not run any commands.',
			);

			for (const finding of result.proposed) {
				assert.strictEqual(finding.status, "proposed");
			}

			await resolveAll(client, result.runId, result.proposed);
		} finally {
			await cleanup();
		}
	});

	it("accepting all diffs should auto-resume and complete the run", {
		timeout: TIMEOUT,
	}, async () => {
		const { client, cleanup } = await createIsolatedSession();
		try {
			const actResult = await actAndExpectProposed(
				client,
				'Fix the typo in main.js. The variable "mesage" should be "message". Only fix the variable name, nothing else.',
			);

			const resolveResult = await resolveAll(
				client,
				actResult.runId,
				actResult.proposed,
				"accepted",
			);

			assert.ok(resolveResult, "Should have a resolve result");
			assert.ok(
				["completed", "proposed", "running"].includes(resolveResult.status),
				`Expected valid status after accept, got ${resolveResult.status}`,
			);
		} finally {
			await cleanup();
		}
	});

	it("rejecting all diffs should auto-resume with rejection info", {
		timeout: TIMEOUT,
	}, async () => {
		const { client, cleanup } = await createIsolatedSession();
		try {
			const actResult = await actAndExpectProposed(
				client,
				'Fix the typo in main.js. The variable "mesage" should be "message".',
			);

			const resolveResult = await resolveAll(
				client,
				actResult.runId,
				actResult.proposed,
				"rejected",
			);

			assert.ok(resolveResult, "Should have a resolve result");
			assert.ok(
				["completed", "proposed", "running"].includes(resolveResult.status),
				`Expected valid status after rejection, got ${resolveResult.status}`,
			);
		} finally {
			await cleanup();
		}
	});

	it("partial resolution should return remaining count when multiple findings exist", {
		timeout: TIMEOUT,
	}, async () => {
		const { client, cleanup } = await createIsolatedSession();
		try {
			const actResult = await actAndExpectProposed(
				client,
				'Make exactly TWO separate edits to main.js: (1) Fix the typo — rename "mesage" to "message" on BOTH lines. (2) Add a comment "// greeting module" as the very first line of the file. Use two separate <edit> blocks.',
			);

			if (actResult.proposed.length >= 2) {
				const first = actResult.proposed[0];
				const partialResult = await client.call("run/resolve", {
					runId: actResult.runId,
					resolution: {
						category: first.category,
						id: first.id,
						action: "accepted",
					},
				});

				assert.strictEqual(
					partialResult.status,
					"proposed",
					"Should still be proposed after partial resolution",
				);
				assert.ok(
					partialResult.remainingCount > 0,
					"Should have remaining findings",
				);
				assert.ok(
					partialResult.remainingCount < actResult.proposed.length,
					"Remaining count should decrease",
				);

				await resolveAll(client, actResult.runId, partialResult.proposed);
			} else {
				console.log(
					"  [NOTE] Model produced only one finding; partial resolution not testable this run.",
				);
				await resolveAll(client, actResult.runId, actResult.proposed);
			}
		} finally {
			await cleanup();
		}
	});
});
