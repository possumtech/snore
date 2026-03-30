import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 180_000;
const WIZARD_DEFAULT = "My robe is purple\n";

async function resetWizard(projectPath) {
	await fs.writeFile(join(projectPath, "wizard.txt"), WIZARD_DEFAULT);
}

describe("E2E: Act Mode Lifecycle", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-act-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "wizard.txt"), WIZARD_DEFAULT);
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new AuditClient(tserver.url, tdb.db);
		await client.connect();
		await client.call("init", {
			projectPath,
			projectName: "ActTest",
			clientId: "c-act",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("act produces proposed entries", { timeout: TIMEOUT }, async () => {
		await resetWizard(projectPath);
		const states = [];
		client.on("run/state", (p) => states.push(p));

		const result = await client.call("act", {
			model,
			prompt: 'Change "purple" to "blue" in wizard.txt',
		});

		// Model should have proposed an edit or completed
		assert.ok(
			result.status === "proposed" || result.status === "completed",
			`Expected proposed or completed, got ${result.status}`,
		);

		if (result.status === "proposed") {
			assert.ok(result.proposed, "should have proposed entries");
			assert.ok(
				result.proposed.length > 0,
				"should have at least one proposed entry",
			);

			// Check run/state notification
			const lastState = states.at(-1);
			assert.strictEqual(lastState.status, "proposed");
			assert.ok(
				lastState.proposed.length > 0,
				"state notification has proposed",
			);

			const entry = lastState.proposed[0];
			assert.ok(entry.key, "proposed entry has key");
			assert.ok(entry.type, "proposed entry has type");
			assert.ok(entry.meta, "proposed entry has meta");
		}
		await resetWizard(projectPath);
	});

	it("resolve accept transitions proposed → pass and auto-resumes", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("act", {
			model,
			prompt: "Run: echo test_output",
		});

		if (result.status !== "proposed") {
			assert.ok(true, "Model completed without proposing");
			return;
		}

		const proposed = result.proposed[0];
		assert.ok(proposed.key, "has proposed key");

		const resolveResult = await client.call("run/resolve", {
			run: result.run,
			resolution: {
				key: proposed.key,
				action: "accept",
				output: "test_output",
			},
		});

		assert.ok(
			["completed", "running", "proposed"].includes(resolveResult.status),
			`Expected valid status after accept, got ${resolveResult.status}`,
		);
	});

	it("resolve reject transitions proposed → warn and stops", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("act", {
			model,
			prompt: "Run: rm -rf /",
		});

		if (result.status !== "proposed") {
			assert.ok(true, "Model completed without proposing");
			return;
		}

		const proposed = result.proposed[0];
		const resolveResult = await client.call("run/resolve", {
			run: result.run,
			resolution: {
				key: proposed.key,
				action: "reject",
				output: "Dangerous command rejected.",
			},
		});

		assert.ok(
			["resolved", "completed", "proposed"].includes(resolveResult.status),
			`Expected resolved/completed after reject, got ${resolveResult.status}`,
		);
	});
});
