import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import SqlRite from "@possumtech/sqlrite";
import ProjectContext from "./ProjectContext.js";
import RepoMap from "./RepoMap.js";

describe("RepoMap (Clean Room)", () => {
	const testBase = join(process.cwd(), "test_repomap_clean");
	let currentDb = null;
	let currentDbPath = null;

	const setup = async (name) => {
		const testDir = join(testBase, name);
		const dbPath = join(testBase, `${name}.db`);
		currentDbPath = dbPath;

		await fs.mkdir(testDir, { recursive: true });
		
		// Initialize git so RepoMap finds files
		const { execSync } = await import("node:child_process");
		execSync('git init && git config user.email "test@test.com" && git config user.name "Test"', { cwd: testDir });

		await fs.unlink(dbPath).catch(() => {});
		const db = await SqlRite.open({ path: dbPath, dir: ["migrations", "src"] });
		currentDb = db;

		const pid = `p-${name}`;
		await db.upsert_project.run({ id: pid, path: testDir, name: "Test" });
		
		return { db, pid, testDir, dbPath };
	};

	afterEach(async () => {
		if (currentDb) {
			await currentDb.close();
			currentDb = null;
		}
		if (currentDbPath) {
			await fs.unlink(currentDbPath).catch(() => {});
			currentDbPath = null;
		}
	});

	after(async () => {
		await fs.rm(testBase, { recursive: true, force: true }).catch(() => {});
	});

	it("should rank root files at 1 and non-root at 0 by default", async () => {
		const { db, pid, testDir } = await setup("baseline");
		await fs.writeFile(join(testDir, "root.js"), "function r() {}");
		await fs.mkdir(join(testDir, "subdir"), { recursive: true });
		await fs.writeFile(join(testDir, "subdir/nested.js"), "function n() {}");
		
		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });

		const ctx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective([]);
		const root = perspective.files.find(f => f.path === "root.js");
		const nested = perspective.files.find(f => f.path === "subdir/nested.js");

		assert.strictEqual(root.rank, 1, "Root file should have rank 1");
		assert.strictEqual(nested.rank, 0, "Non-root file should have rank 0");
	});

	it("should increment rank based on symbol matches in active files", async () => {
		const { db, pid, testDir } = await setup("overlap");
		// File with a symbol 'targetSymbol'
		await fs.writeFile(join(testDir, "lib.js"), "function targetSymbol() {}");
		// Active file that mentions 'targetSymbol'
		await fs.writeFile(join(testDir, "active.js"), "targetSymbol();");
		
		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });

		const ctx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective(["active.js"]);
		const lib = perspective.files.find(f => f.path === "lib.js");
		
		// lib.js is in root (+1) and has 1 match (+1) = rank 2
		assert.strictEqual(lib.rank, 2, "Root file with one match should have rank 2");
	});

	it("should prioritize non-root files with matches over root files without", async () => {
		const { db, pid, testDir } = await setup("sorting");
		await fs.writeFile(join(testDir, "root_cold.js"), "function c() {}");
		await fs.mkdir(join(testDir, "src"), { recursive: true });
		await fs.writeFile(join(testDir, "src/nested_warm.js"), "function hot() {}");
		await fs.writeFile(join(testDir, "active.js"), "hot();");
		
		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });

		const ctx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective(["active.js"]);
		
		// root_cold: rank 1
		// nested_warm: rank 1 (0 root + 1 match)
		// Since ranks are equal, they sort alphabetically. 
		// Let's add a second match to nested_warm.
		await fs.writeFile(join(testDir, "src/nested_warm.js"), "function hot() {} \n function spicy() {}");
		await fs.writeFile(join(testDir, "active.js"), "hot(); spicy();");
		await repoMap.updateIndex();
		
		const p2 = await repoMap.renderPerspective(["active.js"]);
		const cold = p2.files.find(f => f.path === "root_cold.js");
		const warm = p2.files.find(f => f.path === "src/nested_warm.js");

		assert.strictEqual(cold.rank, 1);
		assert.strictEqual(warm.rank, 2, "Nested file with 2 matches should have rank 2");
		
		const firstNonActive = p2.files.filter(f => f.status !== "active")[0];
		assert.strictEqual(firstNonActive.path, "src/nested_warm.js", "Warm nested file should be above cold root file");
	});

	it("should squish rank 0 files when budget is exceeded", async () => {
		const { db, pid, testDir } = await setup("squish");
		await fs.mkdir(join(testDir, "src"), { recursive: true });
		await fs.writeFile(join(testDir, "src/cold.js"), "function a() {} \n function b() {}");
		
		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });

		const ctx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		// Set budget extremely low (1% of 10 tokens = 0.1 tokens)
		process.env.RUMMY_MAP_MAX_PERCENT = "1";
		const perspective = await repoMap.renderPerspective([], { contextSize: 10 });
		const cold = perspective.files.find(f => f.path === "src/cold.js");
		
		assert.ok(!cold || !cold.symbols || cold.symbols.length === 0, "Cold file should be squished or dropped");
	});

	it("should always include active files with full content", async () => {
		const { db, pid, testDir } = await setup("active");
		await fs.writeFile(join(testDir, "active.js"), "console.log('full');");
		
		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });

		const ctx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective(["active.js"], { contextSize: 1 });
		const active = perspective.files.find(f => f.path === "active.js");
		
		assert.strictEqual(active.status, "active");
		assert.strictEqual(active.content, "console.log('full');");
	});

	it("should extract Lua signatures via ctags hack", async () => {
		const { db, pid, testDir } = await setup("lua");
		await fs.writeFile(join(testDir, "init.lua"), "function M.setup(opts)\nend");
		
		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });

		const ctx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective([]);
		const lua = perspective.files.find(f => f.path === "init.lua");
		assert.ok(lua.symbols.some(s => s.name === "M.setup" && s.params === "(opts)"), "Lua signature should be extracted");
	});
});
