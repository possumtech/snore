import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import TestDb from "../../../test/helpers/TestDb.js";
import FindingsManager from "./FindingsManager.js";

test("FindingsManager", async (t) => {
	let tdb, fm, projectId, runId;
	const projectPath = join(tmpdir(), `rummy-fm-test-${Date.now()}`);

	t.before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		tdb = await TestDb.create();
		fm = new FindingsManager(tdb.db);

		await tdb.db.upsert_project.run({
			id: "p1",
			path: projectPath,
			name: "FMTest",
		});
		projectId = "p1";

		await tdb.db.create_session.run({
			id: "s1",
			project_id: projectId,
			client_id: "c1",
		});
		await tdb.db.create_run.run({
			id: "r1",
			session_id: "s1",
			parent_run_id: null,
			type: "act",
			config: "{}",
		});
		runId = "r1";
	});

	t.after(async () => {
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	await t.test("read tool should create agent promotion", async () => {
		await tdb.db.upsert_repo_map_file.get({
			project_id: projectId,
			path: "src/target.js",
			hash: "abc",
			size: 100,
			symbol_tokens: 10,
		});

		await fm.processTools(projectPath, runId, 0, [
			{ tool: "read", path: "src/target.js" },
		]);

		const file = await tdb.db.get_repo_map_file.get({
			project_id: projectId,
			path: "src/target.js",
			run_id: runId,
		});
		assert.strictEqual(file.has_agent_promotion, 1);
	});

	await t.test("drop tool should remove agent promotion", async () => {
		await fm.processTools(projectPath, runId, 1, [
			{ tool: "drop", path: "src/target.js" },
		]);

		const file = await tdb.db.get_repo_map_file.get({
			project_id: projectId,
			path: "src/target.js",
			run_id: runId,
		});
		assert.strictEqual(file.has_agent_promotion, 0);
	});

	await t.test("edit tool should produce unified diff patch", async () => {
		await fs.mkdir(join(projectPath, "src"), { recursive: true });
		await fs.writeFile(join(projectPath, "src/a.js"), "old code\n");

		const { diffs } = await fm.processTools(projectPath, runId, 2, [
			{
				tool: "edit",
				path: "src/a.js",
				search: "old code",
				replace: "new code",
			},
		]);

		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0].type, "edit");
		assert.strictEqual(diffs[0].file, "src/a.js");
		assert.ok(diffs[0].patch.includes("---"), "Should be unified diff");
		assert.ok(diffs[0].patch.includes("+++"), "Should be unified diff");
		assert.strictEqual(diffs[0].error, null);
	});

	await t.test("edit on nonexistent file with search should warn", async () => {
		const { diffs } = await fm.processTools(projectPath, runId, 2, [
			{ tool: "edit", path: "nonexistent.js", search: "old", replace: "new" },
		]);

		assert.strictEqual(diffs.length, 1);
		assert.ok(diffs[0].warning, "Should warn that search block was not found");
	});

	await t.test("create tool should produce diff", async () => {
		const { diffs } = await fm.processTools(projectPath, runId, 3, [
			{ tool: "create", path: "new.js", content: "console.log('hi');" },
		]);

		assert.strictEqual(diffs.length, 1);
		assert.strictEqual(diffs[0].type, "create");
		assert.strictEqual(diffs[0].file, "new.js");
	});

	await t.test("run tool should produce command", async () => {
		const { commands } = await fm.processTools(projectPath, runId, 4, [
			{ tool: "run", command: "npm test" },
		]);

		assert.strictEqual(commands.length, 1);
		assert.strictEqual(commands[0].command, "npm test");
	});

	await t.test("prompt_user tool should produce notification", async () => {
		const { notifications } = await fm.processTools(projectPath, runId, 5, [
			{
				tool: "prompt_user",
				text: "Which option?",
				config: { question: "Which option?", options: [] },
			},
		]);

		assert.strictEqual(notifications.length, 1);
		assert.strictEqual(notifications[0].type, "prompt_user");
		assert.strictEqual(notifications[0].text, "Which option?");
	});
});
