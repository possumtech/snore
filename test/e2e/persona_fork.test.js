import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_TEST_MODEL;
const TIMEOUT = 120_000;

describe("E2E: Persona & Fork", { concurrency: 1 }, () => {
	let tdb, tserver, client;
	const projectRoot = join(tmpdir(), `rummy-persona-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(
			join(projectRoot, "main.py"),
			"def hello(): return 'hi'\n",
		);
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);

		tdb = await TestDb.create("persona_fork");
		tserver = await TestServer.start(tdb.db);
		client = new AuditClient(tserver.url, tdb.db);
		await client.connect();
		await client.call("init", {
			name: "PersonaTest",
			projectRoot,
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectRoot, { recursive: true, force: true });
	});

	it("persona on ask creates run with persona", {
		timeout: TIMEOUT,
	}, async () => {
		const result = await client.call("ask", {
			model,
			prompt: "What language is main.py written in?",
			persona: "You are a grumpy senior Python developer.",
		});

		assert.strictEqual(result.status, 200);

		// Verify persona stored on the run
		const runDetail = await client.call("getRun", { run: result.run });
		assert.strictEqual(
			runDetail.persona,
			"You are a grumpy senior Python developer.",
		);
	});

	it("fork preserves parent known store", { timeout: TIMEOUT }, async () => {
		const run1 = await client.call("ask", {
			model,
			prompt: "What does the hello function do in main.py?",
		});
		assert.strictEqual(run1.status, 200);

		const parentRow = await tdb.db.get_run_by_alias.get({ alias: run1.run });
		const parentEntries = await tdb.db.get_known_entries.all({
			run_id: parentRow.id,
		});

		const run2 = await client.call("ask", {
			model,
			prompt: "Based on what you already know, summarize.",
			run: run1.run,
			fork: true,
		});

		assert.ok(run2.run !== run1.run, "fork should create a new run");

		const forkRow = await tdb.db.get_run_by_alias.get({ alias: run2.run });
		const forkEntries = await tdb.db.get_known_entries.all({
			run_id: forkRow.id,
		});

		const parentFiles = parentEntries.filter((e) => e.scheme === null);
		const forkFiles = forkEntries.filter((e) => e.scheme === null);
		assert.ok(
			forkFiles.length >= parentFiles.length,
			`Fork should inherit files. Parent: ${parentFiles.length}, Fork: ${forkFiles.length}`,
		);
	});
});
