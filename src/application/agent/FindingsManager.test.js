import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import TestDb from "../../../test/helpers/TestDb.js";
import FindingsManager from "./FindingsManager.js";
import ResponseParser from "./ResponseParser.js";

test("FindingsManager", async (t) => {
	let tdb, fm, projectId, runId;
	const projectPath = join(tmpdir(), `rummy-fm-test-${Date.now()}`);

	t.before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		tdb = await TestDb.create();
		fm = new FindingsManager(tdb.db, new ResponseParser());

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

	await t.test("read tag should create agent promotion", async () => {
		const atomicResult = {
			runId,
			sequence: 0,
			content: "",
			diffs: [],
			commands: [],
			notifications: [],
		};

		await fm.populateFindings(projectPath, atomicResult, [
			{
				tagName: "read",
				attrs: [{ name: "file", value: "src/target.js" }],
			},
		]);

		const file = await tdb.db.get_repo_map_file.get({
			project_id: projectId,
			path: "src/target.js",
			run_id: runId,
		});
		assert.ok(file, "File should exist in repo_map_files");
		assert.strictEqual(file.has_agent_promotion, 1);
	});

	await t.test("drop tag should remove agent promotion", async () => {
		const atomicResult = {
			runId,
			sequence: 1,
			content: "",
			diffs: [],
			commands: [],
			notifications: [],
		};

		await fm.populateFindings(projectPath, atomicResult, [
			{
				tagName: "drop",
				attrs: [{ name: "file", value: "src/target.js" }],
			},
		]);

		const file = await tdb.db.get_repo_map_file.get({
			project_id: projectId,
			path: "src/target.js",
			run_id: runId,
		});
		assert.strictEqual(file.has_agent_promotion, 0);
	});

	await t.test("edit tag should produce unified diff patch", async () => {
		// Create the target file so HeuristicMatcher can resolve
		await fs.mkdir(join(projectPath, "src"), { recursive: true });
		await fs.writeFile(join(projectPath, "src/a.js"), "old code\n");

		const atomicResult = {
			runId,
			sequence: 2,
			content: "",
			diffs: [],
			commands: [],
			notifications: [],
		};

		const editContent =
			"<<<<<<< SEARCH\nold code\n=======\nnew code\n>>>>>>> REPLACE";
		await fm.populateFindings(projectPath, atomicResult, [
			{
				tagName: "edit",
				isMock: true,
				attrs: [{ name: "file", value: "src/a.js" }],
				childNodes: [{ value: editContent }],
			},
		]);

		assert.strictEqual(atomicResult.diffs.length, 1);
		assert.strictEqual(atomicResult.diffs[0].type, "edit");
		assert.strictEqual(atomicResult.diffs[0].file, "src/a.js");
		assert.ok(atomicResult.diffs[0].patch.includes("---"), "Should be unified diff");
		assert.ok(atomicResult.diffs[0].patch.includes("+++"), "Should be unified diff");
		assert.strictEqual(atomicResult.diffs[0].error, null);
	});

	await t.test("edit tag with missing file should produce error, no patch", async () => {
		const atomicResult = {
			runId,
			sequence: 2,
			content: "",
			diffs: [],
			commands: [],
			notifications: [],
		};

		const editContent =
			"<<<<<<< SEARCH\nold code\n=======\nnew code\n>>>>>>> REPLACE";
		await fm.populateFindings(projectPath, atomicResult, [
			{
				tagName: "edit",
				isMock: true,
				attrs: [{ name: "file", value: "nonexistent.js" }],
				childNodes: [{ value: editContent }],
			},
		]);

		assert.strictEqual(atomicResult.diffs.length, 1);
		assert.strictEqual(atomicResult.diffs[0].patch, null);
		assert.ok(atomicResult.diffs[0].error);
	});

	await t.test("create tag should populate diffs", async () => {
		const atomicResult = {
			runId,
			sequence: 3,
			content: "",
			diffs: [],
			commands: [],
			notifications: [],
		};

		await fm.populateFindings(projectPath, atomicResult, [
			{
				tagName: "create",
				isMock: true,
				attrs: [{ name: "file", value: "new.js" }],
				childNodes: [{ value: "const x = 1;" }],
			},
		]);

		assert.strictEqual(atomicResult.diffs.length, 1);
		assert.strictEqual(atomicResult.diffs[0].type, "create");
		assert.strictEqual(atomicResult.diffs[0].file, "new.js");
	});

	await t.test("run tag should populate commands", async () => {
		const atomicResult = {
			runId,
			sequence: 4,
			content: "",
			diffs: [],
			commands: [],
			notifications: [],
		};

		await fm.populateFindings(projectPath, atomicResult, [
			{
				tagName: "run",
				isMock: true,
				attrs: [],
				childNodes: [{ value: "npm test" }],
			},
		]);

		assert.strictEqual(atomicResult.commands.length, 1);
		assert.strictEqual(atomicResult.commands[0].command, "npm test");
	});

	await t.test("summary tag should populate notifications", async () => {
		const atomicResult = {
			runId,
			sequence: 5,
			content: "",
			diffs: [],
			commands: [],
			notifications: [],
		};

		await fm.populateFindings(projectPath, atomicResult, [
			{
				tagName: "summary",
				isMock: true,
				attrs: [],
				childNodes: [{ value: "Done." }],
			},
		]);

		assert.strictEqual(atomicResult.notifications.length, 1);
		assert.strictEqual(atomicResult.notifications[0].type, "summary");
		assert.strictEqual(atomicResult.notifications[0].text, "Done.");
	});

});
