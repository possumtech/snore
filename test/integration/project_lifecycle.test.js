import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import SqlRite from "@possumtech/sqlrite";
import ProjectAgent from "../../src/application/agent/ProjectAgent.js";
import createHooks from "../../src/domain/hooks/Hooks.js";

describe("Project Lifecycle Integration", () => {
	let db, agent;
	const projectPath = join(process.cwd(), "test_project_lifecycle");
	const dbPath = join(process.cwd(), "test_lifecycle.db");

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "main.js"), "console.log('hello');");

		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "test@test.com" && git config user.name "Test" && git add .',
			{ cwd: projectPath },
		);

		db = await SqlRite.open({
			path: dbPath,
			dir: ["migrations", "src"],
		});
		agent = new ProjectAgent(db, createHooks());
	});

	after(async () => {
		await db.close();
		await fs.unlink(dbPath).catch(() => {});
		await fs.unlink(`${dbPath}-shm`).catch(() => {});
		await fs.unlink(`${dbPath}-wal`).catch(() => {});
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("should initialize a project and session", async () => {
		const result = await agent.init(projectPath, "LifecycleTest", "c1");
		assert.ok(result.projectId);
		assert.ok(result.sessionId);

		const projects = await db.get_project_by_path.all({ path: projectPath });
		assert.strictEqual(projects.length, 1);
		assert.strictEqual(projects[0].name, "LifecycleTest");
	});

	it("should retrieve mappable files via getFiles", async () => {
		const files = await agent.getFiles(projectPath);
		assert.ok(files.some((f) => f.path === "main.js"));
	});

	it("should update visibility and persist to DB", async () => {
		const { projectId } = await agent.init(projectPath, "LifecycleTest", "c1");
		await agent.updateFiles(projectId, [
			{ path: "main.js", visibility: "ignored" },
		]);

		const files = await db.get_project_repo_map.all({ project_id: projectId });
		const main = files.find((f) => f.path === "main.js");
		assert.strictEqual(main.visibility, "ignored");
	});
});
