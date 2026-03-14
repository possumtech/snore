import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import SqlRite from "@possumtech/sqlrite";
import RepoMap from "./RepoMap.js";

describe("RepoMap (Perspective Engine)", () => {
	const testDir = join(process.cwd(), "test_perspective");
	const dbPath = "test_repomap.db";
	let db;
	const projectId = "test-project";

	before(async () => {
		await fs.mkdir(testDir, { recursive: true });
		// Active file references 'DepClass'
		await fs.writeFile(join(testDir, "active.js"), "const x = new DepClass();");
		// Dependency file defines 'DepClass' and a method
		await fs.writeFile(
			join(testDir, "dependency.js"),
			"export class DepClass { method(a) {} }",
		);

		await fs.unlink(dbPath).catch(() => {});
		db = await SqlRite.open({
			path: dbPath,
			dir: ["migrations", "src"],
		});

		// Create project in DB
		await db.upsert_project.run({
			id: projectId,
			path: testDir,
			name: "Test Project",
		});
	});

	after(async () => {
		if (db) await db.close();
		await fs.unlink(dbPath).catch(() => {});
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("should build a static index in DB and render a dynamic perspective", async () => {
		const mockCtx = {
			root: testDir,
			getMappableFiles: async () => ["active.js", "dependency.js"],
		};

		const repoMap = new RepoMap(mockCtx, db, projectId);

		// 1. Build the Static Index in DB
		await repoMap.updateIndex();

		// Verify DB state
		const index = await db.get_project_repo_map.all({ project_id: projectId });
		assert.ok(index.length > 0);

		const depEntry = index.find(
			(f) => f.path === "dependency.js" && f.name === "DepClass",
		);
		assert.ok(depEntry, "DepClass should be in the index");

		const methodEntry = index.find(
			(f) => f.path === "dependency.js" && f.name === "method",
		);
		assert.ok(methodEntry, "method should be in the index");

		// 2. Render Perspective with 'active.js' focus
		const perspective = await repoMap.renderPerspective(["active.js"]);

		const activeFile = perspective.files.find((f) => f.path === "active.js");
		const depFile = perspective.files.find((f) => f.path === "dependency.js");

		// Active files are Hot by default
		assert.strictEqual(activeFile.mode, "hot", "Active file should be hot");

		// Dependency should be promoted to Hot because DepClass was referenced
		assert.strictEqual(
			depFile.mode,
			"hot",
			"Referenced dependency should be promoted to hot",
		);

		// All symbols in a Hot file should retain their detail
		const methodSymbol = depFile.symbols.find((s) => s.name === "method");
		assert.strictEqual(
			methodSymbol.params,
			"(a)",
			"Method in hot file should retain parameters",
		);
		assert.ok(
			methodSymbol.line,
			"Method in hot file should retain line number",
		);
	});

	it("should handle cold files correctly", async () => {
		const mockCtx = {
			root: testDir,
			getMappableFiles: async () => ["active.js", "dependency.js"],
		};

		const repoMap = new RepoMap(mockCtx, db, projectId);

		// Render Perspective with NO focus
		const perspective = await repoMap.renderPerspective([]);

		const depFile = perspective.files.find((f) => f.path === "dependency.js");

		// Dependency should be cold because nothing references it (no active files)
		assert.strictEqual(
			depFile.mode,
			"cold",
			"Unreferenced dependency should be cold",
		);

		// Symbols in a Cold file should be stripped
		const methodSymbol = depFile.symbols.find((s) => s.name === "method");
		assert.strictEqual(
			methodSymbol.params,
			undefined,
			"Method in cold file should strip parameters",
		);
		assert.strictEqual(
			methodSymbol.line,
			undefined,
			"Method in cold file should strip line number",
		);
	});
});
