import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 120_000;

describe("E2E: Run Modes", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-modes-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "config.json"), '{"port": 3000}\n');
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
			projectName: "ModesTest",
			clientId: "c-modes",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("continue run preserves known store across calls", { timeout: TIMEOUT }, async () => {
		// First call creates a run
		const run1 = await client.call("ask", {
			model,
			prompt: "The port is 3000. Remember that.",
		});
		assert.strictEqual(run1.status, "completed");

		// Continue the same run
		const run2 = await client.call("ask", {
			model,
			prompt: "What port did I tell you about?",
			run: run1.run,
		});
		assert.strictEqual(run2.status, "completed");
		assert.strictEqual(run2.run, run1.run, "should be same run");

		// The run should have entries from both turns
		const runRow = await tdb.db.get_run_by_alias.get({ alias: run1.run });
		const entries = await tdb.db.get_known_entries.all({ run_id: runRow.id });

		// Should have multiple summaries (one per turn)
		const summaries = entries.filter((e) => e.key.startsWith("/:summary/"));
		assert.ok(summaries.length >= 2, `Should have 2+ summaries, got ${summaries.length}`);

		// Should have multiple prompts
		const prompts = entries.filter((e) => e.key.startsWith("/:prompt/"));
		assert.ok(prompts.length >= 2, `Should have 2+ prompts, got ${prompts.length}`);
	});

	it("lite mode skips file bootstrap", { timeout: TIMEOUT }, async () => {
		const result = await client.call("ask", {
			model,
			prompt: "What is 1 + 1?",
			noContext: true,
		});
		assert.strictEqual(result.status, "completed");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		const entries = await tdb.db.get_known_entries.all({ run_id: runRow.id });

		// Should have no file entries (lite mode = no bootstrap)
		const files = entries.filter((e) => e.domain === "file");
		assert.strictEqual(files.length, 0, "Lite mode should have no file entries");

		// Should still have a summary
		const summaries = entries.filter((e) => e.key.startsWith("/:summary/"));
		assert.ok(summaries.length > 0, "Should still have summary");
	});
});
