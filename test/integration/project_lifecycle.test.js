import assert from "node:assert";
import fs from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import SqlRite from "@possumtech/sqlrite";
import ProjectAgent from "../../src/agent/ProjectAgent.js";

describe("Project Lifecycle Integration", () => {
	let db;
	let projectAgent;
	const dbPath = "test_lifecycle.db";
	const projectPath = "/tmp/test-project";

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true }).catch(() => {});
		await fs.unlink(dbPath).catch(() => {});
		db = await SqlRite.open({
			path: dbPath,
			dir: ["migrations", "src"],
		});
		projectAgent = new ProjectAgent(db);
	});

	after(async () => {
		if (db) await db.close();
		await fs.unlink(dbPath).catch(() => {});
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

		const projects = await db.get_project_by_id.all({ id: result.projectId });
		assert.ok(projects && projects.length > 0, "Project should exist");
		assert.strictEqual(projects[0].path, projectPath);

		const sessions = await db.get_session_by_id.all({ id: result.sessionId });
		assert.ok(sessions && sessions.length > 0, "Session should exist");
		assert.strictEqual(sessions[0].project_id, result.projectId);
	});

	it("should handle existing projects and create a new session", async () => {
		const result1 = await projectAgent.init(
			projectPath,
			"Test Project",
			"client-1",
		);
		const result2 = await projectAgent.init(
			projectPath,
			"Test Project",
			"client-2",
		);

		assert.strictEqual(result1.projectId, result2.projectId);
		assert.notStrictEqual(result1.sessionId, result2.sessionId);
	});

	it("should create jobs within a session", async () => {
		const { sessionId } = await projectAgent.init(
			projectPath,
			"Test Project",
			"client-1",
		);

		const jobId = await projectAgent.startJob(sessionId, {
			type: "orchestrator",
			config: { model: "gpt-4o" },
		});

		assert.ok(jobId);
		const jobs = await db.get_job_by_id.all({ id: jobId });
		assert.ok(jobs && jobs.length > 0, "Job should exist");
		assert.strictEqual(jobs[0].session_id, sessionId);
		assert.strictEqual(jobs[0].type, "orchestrator");
	});
});
