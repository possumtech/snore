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

async function createIsolatedSession(files = {}) {
	const projectPath = join(
		tmpdir(),
		`rummy-diff-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await fs.mkdir(projectPath, { recursive: true });

	const fileEntries =
		Object.keys(files).length > 0
			? files
			: {
					"math.js":
						"function add(a, b) {\n\treturn a - b;\n}\nmodule.exports = { add };\n",
				};

	for (const [name, content] of Object.entries(fileEntries)) {
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
		projectName: "DiffProject",
		clientId: `c-${Date.now()}`,
	});

	for (const name of Object.keys(fileEntries)) {
		await client.call("activate", { pattern: name });
	}

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
		`Expected proposed but got ${result.status}. The model did not produce edit findings.`,
	);
	assert.ok(result.proposed.length > 0, "Should have proposed findings");
	return result;
}

async function resolveAll(client, run, proposed, action = "accepted") {
	let last;
	for (const finding of proposed) {
		last = await client.call("run/resolve", {
			run,
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
				'The add function in math.js has a bug — it subtracts instead of adding. Fix it by changing "return a - b" to "return a + b". Put the fix in the edits array.',
			);

			for (const finding of result.proposed) {
				assert.strictEqual(finding.status, "proposed");
			}

			await resolveAll(client, result.run, result.proposed);
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
				'In math.js, change "return a - b" to "return a + b". Put the fix in the edits array.',
			);

			const resolveResult = await resolveAll(
				client,
				actResult.run,
				actResult.proposed,
				"accepted",
			);

			assert.ok(resolveResult, "Should have a resolve result");
			assert.strictEqual(
				resolveResult.status,
				"completed",
				`Accepting all diffs should complete the run, got ${resolveResult.status}`,
			);
		} finally {
			await cleanup();
		}
	});

	it("rejecting all diffs should return resolved without auto-resuming", {
		timeout: TIMEOUT,
	}, async () => {
		const { client, cleanup } = await createIsolatedSession();
		try {
			const actResult = await actAndExpectProposed(
				client,
				'In math.js, change "return a - b" to "return a + b". Put the fix in the edits array.',
			);

			const resolveResult = await resolveAll(
				client,
				actResult.run,
				actResult.proposed,
				"rejected",
			);

			assert.ok(resolveResult, "Should have a resolve result");
			assert.strictEqual(
				resolveResult.status,
				"resolved",
				`Rejected findings should return 'resolved' (no auto-resume), got ${resolveResult.status}`,
			);
		} finally {
			await cleanup();
		}
	});

	it("partial resolution should return remaining count when multiple findings exist", {
		timeout: TIMEOUT,
	}, async () => {
		const { client, cleanup } = await createIsolatedSession({
			"math.js":
				"function add(a, b) {\n\treturn a - b;\n}\nmodule.exports = { add };\n",
			"greet.js":
				"function greet(name) {\n\treturn 'goodby ' + name;\n}\nmodule.exports = { greet };\n",
		});
		try {
			const actResult = await actAndExpectProposed(
				client,
				'Fix both bugs: (1) In math.js change "return a - b" to "return a + b". (2) In greet.js change "goodby" to "goodbye". Put both fixes in the edits array.',
			);

			const diffFindings = actResult.proposed.filter(
				(f) => f.category === "diff",
			);

			if (diffFindings.length >= 2) {
				const first = diffFindings[0];
				const partialResult = await client.call("run/resolve", {
					run: actResult.run,
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

				await resolveAll(client, actResult.run, partialResult.proposed);
			} else {
				console.log(
					"  [NOTE] Model merged findings into fewer than 2 diffs; partial resolution not testable this run.",
				);
				await resolveAll(client, actResult.run, actResult.proposed);
			}
		} finally {
			await cleanup();
		}
	});
});
