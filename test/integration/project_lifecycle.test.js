import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import ProjectAgent from "../../src/agent/ProjectAgent.js";
import { registerPlugins } from "../../src/plugins/index.js";
import TestDb from "../helpers/TestDb.js";

describe("Project Lifecycle Integration", () => {
	let tdb;
	let projectAgent;
	const projectPath = join(process.cwd(), "test_lifecycle_dir");

	before(async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
		process.env.RUMMY_HTTP_REFERER = "http://test";
		process.env.RUMMY_X_TITLE = "Test";

		await fs.mkdir(projectPath, { recursive: true }).catch(() => {});
		tdb = await TestDb.create("lifecycle");

		// Ensure plugins are registered for the agent to work (e.g. RepoMapPlugin)
		await registerPlugins();

		projectAgent = new ProjectAgent(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
	});

	it("should create a project and a session on init", async () => {
		const result = await projectAgent.init(
			projectPath,
			"Test Project",
			"client-1",
		);
		assert.ok(result.projectId);
		assert.ok(result.sessionId);

		const projects = await tdb.db.get_project_by_id.all({
			id: result.projectId,
		});
		assert.strictEqual(projects[0].path, projectPath);
	});

	it("should handle existing projects and create a new session", async () => {
		const res1 = await projectAgent.init(projectPath, "Test", "c1");
		const res2 = await projectAgent.init(projectPath, "Test", "c2");
		assert.strictEqual(res1.projectId, res2.projectId);
		assert.notStrictEqual(res1.sessionId, res2.sessionId);
	});

	it("should handle the 'ask' lifecycle (Paris test)", async () => {
		const { sessionId } = await projectAgent.init(projectPath, "Test", "c1");

		mock.method(globalThis, "fetch", async () => ({
			ok: true,
			json: async () => ({
				choices: [{ message: { role: "assistant", content: "Paris" } }],
				usage: { total_tokens: 42 },
			}),
		}));

		const result = await projectAgent.ask(
			sessionId,
			"gpt-4o",
			"Capital of France?",
		);
		assert.strictEqual(result.content, "Paris");
		assert.ok(result.runId);
	});
});
