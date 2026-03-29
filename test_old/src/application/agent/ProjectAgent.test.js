import assert from "node:assert";
import test from "node:test";
import TestDb from "../../../test/helpers/TestDb.js";
import createHooks from "../../domain/hooks/Hooks.js";
import ProjectAgent from "./ProjectAgent.js";

test("ProjectAgent (Facade Delegation)", async (t) => {
	let tdb, agent;
	let projectId, sessionId;

	t.before(async () => {
		tdb = await TestDb.create();
		const hooks = createHooks();
		agent = new ProjectAgent(tdb.db, hooks);

		const result = await agent.init("/tmp/pa-test", "PATest", "c1");
		projectId = result.projectId;
		sessionId = result.sessionId;
	});

	t.after(async () => {
		await tdb.cleanup();
	});

	await t.test("init should return projectId and sessionId", () => {
		assert.ok(projectId);
		assert.ok(sessionId);
	});

	await t.test("activate should delegate to session manager", async () => {
		await tdb.db.upsert_repo_map_file.get({
			project_id: projectId,
			path: "src/a.js",
			hash: null,
			size: 100,
			symbol_tokens: 0,
		});
		const result = await agent.activate(projectId, "src/a.js");
		assert.strictEqual(result.status, "ok");
	});

	await t.test("readOnly should delegate", async () => {
		const result = await agent.readOnly(projectId, "src/a.js");
		assert.strictEqual(result.status, "ok");
	});

	await t.test("ignore should delegate", async () => {
		const result = await agent.ignore(projectId, "src/a.js");
		assert.strictEqual(result.status, "ok");
	});

	await t.test("drop should delegate", async () => {
		const result = await agent.drop(projectId, "src/a.js");
		assert.strictEqual(result.status, "ok");
	});

	await t.test("fileStatus should delegate", async () => {
		const status = await agent.fileStatus(projectId, "src/a.js");
		assert.strictEqual(status.path, "src/a.js");
	});

	await t.test("getFiles should delegate", async () => {
		const files = await agent.getFiles("/tmp/pa-test");
		assert.ok(Array.isArray(files));
	});

	await t.test("syncBuffered should delegate", async () => {
		await agent.syncBuffered(projectId, ["src/a.js"]);
	});

	await t.test("startRun should delegate", async () => {
		const runId = await agent.startRun(sessionId, { type: "ask" });
		assert.ok(runId);
	});

	await t.test("setSystemPrompt should delegate", async () => {
		await agent.setSystemPrompt(sessionId, "test");
	});

	await t.test("setPersona should delegate", async () => {
		await agent.setPersona(sessionId, "test");
	});

	await t.test("addSkill should delegate", async () => {
		await agent.addSkill(sessionId, "test-skill");
	});

	await t.test("removeSkill should delegate", async () => {
		await agent.removeSkill(sessionId, "test-skill");
	});
});
