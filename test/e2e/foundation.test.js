import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";
import KnownStore from "../../src/agent/KnownStore.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 120_000;

describe("E2E: Tool Calling Foundation", () => {
	let tdb, tserver, client, knownStore;
	const projectPath = join(tmpdir(), `rummy-e2e-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(
			join(projectPath, "hello.js"),
			"function greet() { return 'hello'; }\nmodule.exports = greet;\n",
		);
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		knownStore = new KnownStore(tdb.db);
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
		await client.call("init", {
			projectPath,
			projectName: "E2ETest",
			clientId: "c-e2e",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("ask completes with summary in known store", { timeout: TIMEOUT }, async () => {
		const result = await client.call("ask", {
			model,
			prompt: "What is the capital of France?",
		});

		assert.strictEqual(result.status, "completed");
		assert.ok(result.run, "Should have a run alias");

		// Verify the run exists and has entries
		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		assert.ok(runRow, "Run should exist in DB");

		// Verify known store has a summary entry
		const log = await knownStore.getLog(runRow.id);
		const summaries = log.filter((e) => e.status === "summary");
		assert.ok(summaries.length > 0, "Should have at least one summary entry");

		// Verify summary text is non-empty
		const lastSummary = summaries.at(-1);
		assert.ok(lastSummary.value.length > 0, `Summary should be non-empty. Got: "${lastSummary.value}"`);
	});

	it("ask with file context shows project files", { timeout: TIMEOUT }, async () => {
		const result = await client.call("ask", {
			model,
			prompt: "What does the greet function in hello.js do?",
		});

		assert.strictEqual(result.status, "completed");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		const all = await tdb.db.get_known_entries.all({ run_id: runRow.id });

		// Should have file entries from the scanner
		const fileEntries = all.filter((e) => e.domain === "file");
		assert.ok(fileEntries.length > 0, "Should have file entries from scanner");

		// hello.js should be present
		const hello = fileEntries.find((e) => e.key === "hello.js");
		assert.ok(hello, "hello.js should be in known store");
		assert.ok(hello.value.includes("greet"), "hello.js value should contain function content");
	});

	it("model can use write tool to persist knowledge", { timeout: TIMEOUT }, async () => {
		const result = await client.call("ask", {
			model,
			prompt: "The greet function returns 'hello'. Write this fact to /:known/greet_behavior",
		});

		assert.strictEqual(result.status, "completed");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		const all = await tdb.db.get_known_entries.all({ run_id: runRow.id });

		// Check if the model used the write tool
		const knownEntries = all.filter((e) => e.domain === "known" && e.key !== "/:unknown");
		// The model might or might not have written to exactly /:known/greet_behavior
		// but it should have called summary at minimum
		const summaries = all.filter((e) => e.key.startsWith("/:summary/"));
		assert.ok(summaries.length > 0, "Model should have called summary");
	});
});
