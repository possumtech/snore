import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import SqlRite from "@possumtech/sqlrite";
import ProjectContext from "./ProjectContext.js";
import RepoMap from "./RepoMap.js";

describe("RepoMap (Perspective Engine)", () => {
	const testDir = join(process.cwd(), "test_repomap_unit");
	const dbPath = "test_repomap_unit.db";
	let db;
	const projectId = "test-project";

	before(async () => {
		process.env.RUMMY_MAP_TOKEN_BUDGET = "1000";
		await fs.mkdir(testDir, { recursive: true });
		await fs.writeFile(join(testDir, "active.js"), "const x = 1;");
		await fs.writeFile(join(testDir, "dep.js"), "function dep() {}");

		await fs.unlink(dbPath).catch(() => {});
		db = await SqlRite.open({ path: dbPath, dir: ["migrations", "src"] });
		await db.upsert_project.run({ id: projectId, path: testDir, name: "Test" });
	});

	after(async () => {
		await db.close();
		await fs.unlink(dbPath).catch(() => {});
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("should build index and render perspective", async () => {
		const ctx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(ctx, db, projectId);

		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective(["active.js"]);
		assert.ok(perspective.files.length > 0);
		assert.ok(perspective.usage.tokens > 0);
	});

	it("should handle token budgeting", async () => {
		const ctx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(ctx, db, projectId);

		// Force tiny budget
		process.env.RUMMY_MAP_TOKEN_BUDGET = "10";
		const perspective = await repoMap.renderPerspective([]);
		// Pruning should happen (but active files always stay)
		assert.ok(perspective.usage.tokens <= 100); // Json overhead is significant
	});
});
