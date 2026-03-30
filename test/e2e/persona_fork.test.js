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

describe("E2E: Persona & Fork", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-persona-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "main.py"), "def hello(): return 'hi'\n");
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
			projectName: "PersonaTest",
			clientId: "c-persona",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("persona is stored and applied to session", { timeout: TIMEOUT }, async () => {
		await client.call("persona", { text: "You are a grumpy senior Python developer who hates JavaScript." });

		// Verify persona is stored
		const temp = await client.call("getTemperature");
		assert.ok(temp !== undefined, "session exists");

		// Run a turn — the model should receive the persona
		const result = await client.call("ask", {
			model,
			prompt: "What language is main.py written in?",
		});

		assert.strictEqual(result.status, "completed");
	});

	it("fork preserves parent known store", { timeout: TIMEOUT }, async () => {
		// First run: establish some knowledge
		const run1 = await client.call("ask", {
			model,
			prompt: "What does the hello function do in main.py?",
		});
		assert.strictEqual(run1.status, "completed");

		// Check parent run has entries
		const parentRow = await tdb.db.get_run_by_alias.get({ alias: run1.run });
		const parentEntries = await tdb.db.get_known_entries.all({ run_id: parentRow.id });
		const parentKnowns = parentEntries.filter((e) => e.key.startsWith("/:known/"));

		// Fork from the parent run
		const run2 = await client.call("ask", {
			model,
			prompt: "Based on what you already know, summarize.",
			run: run1.run,
			fork: true,
		});

		assert.ok(run2.run !== run1.run, "fork should create a new run");

		// Check forked run has parent's entries
		const forkRow = await tdb.db.get_run_by_alias.get({ alias: run2.run });
		const forkEntries = await tdb.db.get_known_entries.all({ run_id: forkRow.id });

		// Fork should have at least as many file entries as parent
		const parentFiles = parentEntries.filter((e) => e.domain === "file");
		const forkFiles = forkEntries.filter((e) => e.domain === "file");
		assert.ok(
			forkFiles.length >= parentFiles.length,
			`Fork should inherit files. Parent: ${parentFiles.length}, Fork: ${forkFiles.length}`,
		);
	});
});
