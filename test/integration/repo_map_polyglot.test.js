import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import SqlRite from "@possumtech/sqlrite";
import GitProvider from "../../src/core/GitProvider.js";
import ProjectContext from "../../src/core/ProjectContext.js";
import RepoMap from "../../src/core/RepoMap.js";

describe("RepoMap Polyglot Integration", () => {
	const testDir = join(process.cwd(), "test_polyglot");
	const dbPath = "test_polyglot.db";
	let db;
	const projectId = "test-polyglot-project";

	before(async () => {
		await fs.mkdir(testDir, { recursive: true });
		// Create files in multiple languages
		await fs.writeFile(
			join(testDir, "main.py"),
			"class PyClass:\n    def method(self): pass",
		);
		await fs.writeFile(
			join(testDir, "lib.rs"),
			"struct RustStruct { x: i32 }\nfn rust_func() {}",
		);
		await fs.writeFile(join(testDir, "app.go"), "package main\nfunc main() {}");
		await fs.writeFile(join(testDir, "README.md"), "# Heading 1\n## Heading 2");

		await fs.unlink(dbPath).catch(() => {});
		db = await SqlRite.open({
			path: dbPath,
			dir: ["migrations", "src"],
		});

		// Create project in DB
		await db.upsert_project.run({
			id: projectId,
			path: testDir,
			name: "Polyglot Project",
		});

		// Force non-git so we only see what we explicitly allow
		mock.method(GitProvider, "detectRoot", async () => null);
	});

	after(async () => {
		mock.restoreAll();
		if (db) await db.close();
		await fs.unlink(dbPath).catch(() => {});
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("should generate a map for a multi-language project (using ctags)", async () => {
		// Explicitly map files since we are in non-git mode
		const visibility = new Map([
			["main.py", "mappable"],
			["lib.rs", "mappable"],
			["app.go", "mappable"],
			["README.md", "mappable"],
		]);

		const ctx = await ProjectContext.open(testDir, visibility);
		const repoMap = new RepoMap(ctx, db, projectId);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective([]);

		assert.strictEqual(perspective.files.length, 4);

		const pyFile = perspective.files.find((f) => f.path === "main.py");
		assert.ok(
			pyFile.symbols.some((s) => s.name === "PyClass"),
			"Should contain Python class",
		);

		const rsFile = perspective.files.find((f) => f.path === "lib.rs");
		assert.ok(
			rsFile.symbols.some((s) => s.name === "RustStruct"),
			"Should contain Rust struct",
		);

		const goFile = perspective.files.find((f) => f.path === "app.go");
		assert.ok(
			goFile.symbols.some((s) => s.name === "main"),
			"Should contain Go function",
		);

		const mdFile = perspective.files.find((f) => f.path === "README.md");
		assert.ok(
			mdFile.symbols.some((s) => s.name === "Heading 1"),
			"Should contain Markdown heading",
		);
	});
});
