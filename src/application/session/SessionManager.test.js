import assert from "node:assert";
import test from "node:test";
import TestDb from "../../../test/helpers/TestDb.js";
import createHooks from "../../domain/hooks/Hooks.js";
import SessionManager from "./SessionManager.js";

test("SessionManager", async (t) => {
	let tdb, manager, hooks;
	let projectId, sessionId;

	t.before(async () => {
		tdb = await TestDb.create();
		hooks = createHooks();
		manager = new SessionManager(tdb.db, hooks);

		const result = await manager.init("/tmp/sm-test", "SMTest", "c1");
		projectId = result.projectId;
		sessionId = result.sessionId;
	});

	t.after(async () => {
		await tdb.cleanup();
	});

	await t.test("init should create project and session", async () => {
		assert.ok(projectId);
		assert.ok(sessionId);
	});

	await t.test(
		"activate should create client promotion with full constraint",
		async () => {
			// Ensure files exist in repo_map_files first
			await tdb.db.upsert_repo_map_file.get({
				project_id: projectId,
				path: "src/a.js",
				hash: null,
				size: 100,
				symbol_tokens: 0,
			});

			const result = await manager.activate(projectId, "src/a.js");
			assert.strictEqual(result.status, "ok");

			const file = await tdb.db.get_repo_map_file.get({
				project_id: projectId,
				path: "src/a.js",
				run_id: null,
			});
			assert.strictEqual(file.client_constraint, "full");
		},
	);

	await t.test(
		"readOnly should create client promotion with full:readonly",
		async () => {
			const result = await manager.readOnly(projectId, "src/a.js");
			assert.strictEqual(result.status, "ok");

			const file = await tdb.db.get_repo_map_file.get({
				project_id: projectId,
				path: "src/a.js",
				run_id: null,
			});
			assert.strictEqual(file.client_constraint, "full:readonly");
		},
	);

	await t.test(
		"ignore should create client promotion with excluded",
		async () => {
			const result = await manager.ignore(projectId, "src/a.js");
			assert.strictEqual(result.status, "ok");

			const file = await tdb.db.get_repo_map_file.get({
				project_id: projectId,
				path: "src/a.js",
				run_id: null,
			});
			assert.strictEqual(file.client_constraint, "excluded");
		},
	);

	await t.test("drop should remove client promotion", async () => {
		const result = await manager.drop(projectId, "src/a.js");
		assert.strictEqual(result.status, "ok");

		const file = await tdb.db.get_repo_map_file.get({
			project_id: projectId,
			path: "src/a.js",
			run_id: null,
		});
		assert.strictEqual(file.client_constraint, null);
	});

	await t.test("fileStatus should return promotion state", async () => {
		await manager.activate(projectId, "src/a.js");
		const status = await manager.fileStatus(projectId, "src/a.js");

		assert.strictEqual(status.path, "src/a.js");
		assert.strictEqual(status.fidelity, "full");
		assert.strictEqual(status.client_constraint, "full");
		assert.strictEqual(status.has_agent_promotion, false);
		assert.strictEqual(status.has_editor_promotion, false);
	});

	await t.test(
		"syncBuffered should create and clear editor promotions",
		async () => {
			await manager.syncBuffered(projectId, ["src/a.js"]);

			const file = await tdb.db.get_repo_map_file.get({
				project_id: projectId,
				path: "src/a.js",
				run_id: null,
			});
			assert.strictEqual(file.has_editor_promotion, 1);

			// Re-sync with empty clears editor promotions
			await manager.syncBuffered(projectId, []);

			const after = await tdb.db.get_repo_map_file.get({
				project_id: projectId,
				path: "src/a.js",
				run_id: null,
			});
			assert.strictEqual(after.has_editor_promotion, 0);
		},
	);

	await t.test("startRun should create a run with alias", async () => {
		const result = await manager.startRun(sessionId, { type: "ask" });
		assert.ok(result.runId);
		assert.ok(result.alias);
		assert.ok(result.alias.includes("_"), "alias should be model_N format");
	});

	await t.test("activate with absolute path should normalize", async () => {
		const result = await manager.activate(projectId, "/tmp/sm-test/src/a.js");
		assert.strictEqual(result.status, "ok");
		const file = await tdb.db.get_repo_map_file.get({
			project_id: projectId,
			path: "src/a.js",
			run_id: null,
		});
		assert.strictEqual(file.client_constraint, "full");
	});

	await t.test("addSkill and removeSkill should work", async () => {
		await manager.addSkill(sessionId, "test-skill");
		await manager.removeSkill(sessionId, "test-skill");
	});

	await t.test("setPersona should update session", async () => {
		await manager.setPersona(sessionId, "test persona");
	});

	await t.test("setSystemPrompt should update session", async () => {
		await manager.setSystemPrompt(sessionId, "test prompt");
	});

	await t.test("getFiles should return file list", async () => {
		const files = await manager.getFiles("/tmp/sm-test");
		assert.ok(Array.isArray(files));
	});
});
