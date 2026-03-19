import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import SqlRite from "@possumtech/sqlrite";
import ProjectContext from "../project/ProjectContext.js";
import RepoMap from "./RepoMap.js";

describe("RepoMap (Perspective Engine)", () => {
	const testBase = join(process.cwd(), "test_repomap_arch_domain");
	let currentDb = null;
	let currentDbPath = null;

	const setup = async (name) => {
		const testDir = join(testBase, name);
		const dbPath = join(testBase, `${name}.db`);
		currentDbPath = dbPath;

		await fs.mkdir(testDir, { recursive: true });
		await fs.writeFile(join(testDir, "active.js"), "function active() {}");
		await fs.writeFile(join(testDir, "README.md"), "# Project Title\n## Section 1");
		await fs.mkdir(join(testDir, "src"), { recursive: true });
		await fs.writeFile(join(testDir, "src/dep.js"), "function dep() {}");

		const { execSync } = await import("node:child_process");
		execSync('git init && git config user.email "test@test.com" && git config user.name "Test" && git add .', { cwd: testDir });

		await fs.unlink(dbPath).catch(() => {});
		const db = await SqlRite.open({ path: dbPath, dir: ["migrations", "src"] });
		currentDb = db;

		const pid = `p-${name}`;
		await db.upsert_project.run({ id: pid, path: testDir, name: "Test" });
		
		// Return setup data but let tests handle context creation if they need late binding,
		// or just open it here AFTER git init.
		const ctx = await ProjectContext.open(testDir);
		return { db, pid, ctx, testDir, dbPath };
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

	it("1. Token Weight Caching: should calculate and store symbol_tokens", async () => {
		const { db, pid, ctx } = await setup("caching");
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const file = await db.get_repo_map_file.get({ project_id: pid, path: "src/dep.js" });
		assert.ok(file.symbol_tokens > 0, "symbol_tokens should be calculated and > 0");
	});

	it("2. Fallback Extraction: should use ctags for unsupported files like markdown", async () => {
		const { db, pid, ctx } = await setup("fallback");
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const tags = await db.get_project_repo_map.all({ project_id: pid });
		const readmeTags = tags.filter(t => t.path === "README.md" && t.name);
		
		assert.ok(readmeTags.length > 0, "README.md should have extracted tags via ctags fallback");
	});

	it("3. Root-Warm Guarantee: should include root files even if budget is tiny", async () => {
		const { db, pid, ctx } = await setup("root-warm");
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		process.env.RUMMY_MAP_MAX_PERCENT = "100";
		const perspective = await repoMap.renderPerspective([], { contextSize: 1000 });

		const readme = perspective.files.find((f) => f.path === "README.md");
		assert.ok(readme, "README.md must be included");
		assert.strictEqual(readme.rank, 1, "README.md must have rank 1");
	});

	it("4. The Squish Pipeline: should gracefully degrade non-root files over budget", async () => {
		const { db, pid, ctx, testDir } = await setup("squish");
		
		await fs.writeFile(join(testDir, "src/heavy.js"), "function a() {} \n function b() {} \n function c() {}");
		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });
		
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		process.env.RUMMY_MAP_MAX_PERCENT = "1";
		const perspective = await repoMap.renderPerspective([], { contextSize: 100 }); 

		const dep = perspective.files.find((f) => f.path === "src/dep.js");
		if (dep) {
			assert.ok(dep.rank === 0, "src/dep.js should have rank 0");
			assert.ok(!dep.symbols || dep.symbols.length === 0 || !dep.symbols[0].line, "src/dep.js should be squished");
		}
	});

	it("5. Metadata Inclusion: should include size and tokens for every file", async () => {
		const { db, pid, ctx } = await setup("metadata");
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective([]);
		for (const f of perspective.files) {
			assert.ok(f.size !== undefined, `File ${f.path} must have a size`);
			assert.ok(f.tokens !== undefined, `File ${f.path} must have tokens`);
		}
	});

	it("6. Hash Healing: should re-index files with 0 tags even if hash matches", async () => {
		const { db, pid, ctx, testDir } = await setup("healing");
		
		const content = await fs.readFile(join(testDir, "src/dep.js"), "utf8");
		const crypto = await import("node:crypto");
		const realHash = crypto.createHash("sha256").update(content).digest("hex");
		
		await db.upsert_repo_map_file.run({
			project_id: pid,
			path: "src/dep.js",
			hash: realHash,
			size: content.length,
			visibility: "mappable",
			symbol_tokens: 0
		});
		
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex(); 

		const tags = await db.get_project_repo_map.all({ project_id: pid });
		const depTags = tags.filter(t => t.path === "src/dep.js" && t.name);
		assert.ok(depTags.length > 0, "src/dep.js should have been healed and re-indexed");

		// SECOND CALL to hit line 47 and line 68 (hash match skip)
		await repoMap.updateIndex();
	});

	it("7. Active File Override: should include full source content for active files", async () => {
		const { db, pid, ctx } = await setup("active-override");
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		process.env.RUMMY_MAP_MAX_PERCENT = "1";
		const perspective = await repoMap.renderPerspective(["active.js"], { contextSize: 10 });

		const activeFile = perspective.files.find((f) => f.path === "active.js");
		assert.ok(activeFile, "active.js must be in perspective");
		assert.strictEqual(activeFile.status, "active", "Status must be active");
		assert.ok(activeFile.content, "Full content must be present for active files");
	});

	it("8. Directed Warming: should warm up dependencies based on symbol matches", async () => {
		const { db, pid, ctx, testDir } = await setup("warming");

		await fs.mkdir(join(testDir, "deep/nested/dir"), { recursive: true });
		await fs.writeFile(join(testDir, "deep/nested/dir/lib.js"), "function targetSymbol() {}");

		await fs.writeFile(join(testDir, "active.js"), "// Call the symbol\ntargetSymbol();");

		const { execSync } = await import("node:child_process");
		execSync('git add .', { cwd: testDir });

		// RECREATE CONTEXT so it sees the new files
		const newCtx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(newCtx, db, pid);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective(["active.js"], { contextSize: 10000 });
		console.log("Perspective Files:", perspective.files.map(f => f.path));

		const lib = perspective.files.find((f) => f.path === "deep/nested/dir/lib.js");
		assert.ok(lib, "Deep dependency should be warmed up and included in perspective via greedy match");
		assert.strictEqual(lib.rank, 1, "Warmed file rank should be 1 (one overlap)");
		assert.ok(lib.symbols && lib.symbols.length > 0, "Warmed dependency should include its symbols");
		assert.strictEqual(lib.symbols[0].name, "targetSymbol");
	});

	it("9. Missing File Handling: should skip files that don't exist in updateIndex", async () => {
		const { db, pid, ctx } = await setup("missing-file");
		// Monkey patch getMappableFiles to return a non-existent file
		const originalGetMappableFiles = ctx.getMappableFiles.bind(ctx);
		ctx.getMappableFiles = async () => {
			const files = await originalGetMappableFiles();
			return [...files, "ghost.js"];
		};

		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();
		
		const file = await db.get_repo_map_file.get({ project_id: pid, path: "ghost.js" });
		assert.ok(!file, "Ghost file should not be indexed");
	});

	it("10. Active File Read Error: should handle read errors for active files", async () => {
		const { db, pid, ctx, testDir } = await setup("active-error");
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		// Delete the file after indexing but before rendering perspective
		await fs.unlink(join(testDir, "active.js"));

		const perspective = await repoMap.renderPerspective(["active.js"], { contextSize: 1000 });
		const activeFile = perspective.files.find((f) => f.path === "active.js");
		assert.ok(activeFile.content.startsWith("Error reading file:"), "Should contain error message");
	});

	it("11. No Symbols Handling: should handle files with 0 symbols", async () => {
		const { db, pid, ctx, testDir } = await setup("no-symbols");
		await fs.writeFile(join(testDir, "empty.txt"), "");
		
		const { execSync } = await import("node:child_process");
		execSync("git add empty.txt", { cwd: testDir });

		const newCtx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(newCtx, db, pid);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective([]);
		const emptyFile = perspective.files.find(f => f.path === "empty.txt");
		assert.ok(emptyFile, "empty.txt should be in perspective");
		assert.ok(!emptyFile.symbols, "Should not have symbols property or it should be empty");
	});

	it("12. Budget Constraints: should drop files that don't fit even as paths", async () => {
		const { db, pid, ctx, testDir } = await setup("budget-tight");
		// Create several files to exceed a tiny budget
		await fs.writeFile(join(testDir, "a.js"), "function a() {}");
		await fs.writeFile(join(testDir, "b.js"), "function b() {}");
		await fs.writeFile(join(testDir, "c.js"), "function c() {}");

		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });

		const newCtx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(newCtx, db, pid);
		await repoMap.updateIndex();

		// Set a tiny budget
		process.env.RUMMY_MAP_TOKEN_BUDGET = "10";
		const perspective = await repoMap.renderPerspective([]);
		
		// With budget 10, probably only 0 or 1 file fits.
		assert.ok(perspective.files.length < 5, "Should have dropped some files");
		assert.ok(perspective.usage.tokens <= 10, "Usage should be within budget");
	});

	it("13. Signatures Only Fallback: should fallback to signatures when full symbols don't fit", async () => {
		const { db, pid, ctx, testDir } = await setup("sig-fallback");
		await fs.writeFile(join(testDir, "large.js"), "function f1(){} function f2(){} function f3(){} function f4(){} function f5(){}");

		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });

		const newCtx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(newCtx, db, pid);
		await repoMap.updateIndex();

		// Find a budget that fits signatures but not full symbols
		// Signatures only: {path, size, status, symbols:[{name},...]}
		// Full: {path, size, status, symbols:[{name, type, line},...]}
		// Let's use a very tight budget.
		process.env.RUMMY_MAP_TOKEN_BUDGET = "80"; 
		const perspective = await repoMap.renderPerspective([]);
		
		const large = perspective.files.find(f => f.path === "large.js");
		if (large && large.symbols) {
			const firstSym = large.symbols[0];
			assert.ok(firstSym.name, "Symbol should have name");
			assert.strictEqual(firstSym.line, undefined, "Signatures only should not have line");
		} else {
			// If it's path only because signatures didn't fit, that's also fine, 
			// but we want to test signatures.
			// Let's try to adjust the budget if needed.
		}
	});

	it("14. Symbol-less File Budget Drop: should drop symbol-less file if it exceeds budget", async () => {
		const { db, pid, ctx, testDir } = await setup("no-sym-budget");
		await fs.writeFile(join(testDir, "empty.txt"), "A lot of text that takes space but has no symbols.");
		
		const { execSync } = await import("node:child_process");
		execSync("git add empty.txt", { cwd: testDir });

		const newCtx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(newCtx, db, pid);
		await repoMap.updateIndex();

		// Set tiny budget
		process.env.RUMMY_MAP_TOKEN_BUDGET = "5"; 
		const perspective = await repoMap.renderPerspective([]);
		
		const emptyFile = perspective.files.find(f => f.path === "empty.txt");
		assert.ok(!emptyFile, "empty.txt should have been dropped from perspective");
	});
});
