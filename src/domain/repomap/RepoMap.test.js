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
		await fs.writeFile(
			join(testDir, "README.md"),
			"# Project Title\n## Section 1",
		);
		await fs.mkdir(join(testDir, "src"), { recursive: true });
		await fs.writeFile(join(testDir, "src/dep.js"), "function dep() {}");

		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "test@test.com" && git config user.name "Test" && git add .',
			{ cwd: testDir },
		);

		await fs.unlink(dbPath).catch(() => {});
		const db = await SqlRite.open({ path: dbPath, dir: ["migrations", "src"] });
		currentDb = db;

		const pid = `p-${name}`;
		await db.upsert_project.run({ id: pid, path: testDir, name: "Test" });

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

		const file = await db.get_repo_map_file.get({
			project_id: pid,
			path: "src/dep.js",
		});
		assert.ok(
			file.symbol_tokens > 0,
			"symbol_tokens should be calculated and > 0",
		);
	});

	it("2. Fallback Extraction: should use ctags for unsupported files like markdown", async () => {
		const { db, pid, ctx } = await setup("fallback");
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const tags = await db.get_project_repo_map.all({ project_id: pid });
		const readmeTags = tags.filter((t) => t.path === "README.md" && t.name);

		assert.ok(
			readmeTags.length > 0,
			"README.md should have extracted tags via ctags fallback",
		);
	});

	it("3. Root-Warm Guarantee: should include root files even if budget is tiny", async () => {
		const { db, pid, ctx } = await setup("root-warm");
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective({
			contextSize: 1000,
			sequence: 1,
		});

		const readme = perspective.files.find((f) => f.path === "README.md");
		assert.ok(readme, "README.md must be included");
		assert.strictEqual(
			readme.heat,
			1,
			"README.md must have heat 1 (root bonus)",
		);
	});

	it("4. The Squish Pipeline: should gracefully degrade non-root files over budget", async () => {
		const { db, pid, ctx, testDir } = await setup("squish");

		await fs.writeFile(
			join(testDir, "src/heavy.js"),
			"function a() {} \n function b() {} \n function c() {}",
		);
		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });

		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		// Set tiny budget
		process.env.RUMMY_MAP_TOKEN_BUDGET = "100";
		const perspective = await repoMap.renderPerspective({ sequence: 1 });

		const dep = perspective.files.find((f) => f.path === "src/dep.js");
		if (dep) {
			assert.ok(dep.heat === 0, "src/dep.js should have heat 0");
			assert.ok(
				!dep.symbols || !dep.symbols[0]?.line,
				"src/dep.js should be squished",
			);
		}
	});

	it("5. Metadata Inclusion: should include size and tokens for every file", async () => {
		const { db, pid, ctx } = await setup("metadata");
		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective({ sequence: 1 });
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
			symbol_tokens: 0,
		});

		const repoMap = new RepoMap(ctx, db, pid);
		await repoMap.updateIndex();

		const tags = await db.get_project_repo_map.all({ project_id: pid });
		const depTags = tags.filter((t) => t.path === "src/dep.js" && t.name);
		assert.ok(
			depTags.length > 0,
			"src/dep.js should have been healed and re-indexed",
		);
	});

	it("7. Active File Override: should include full source content for active files", async () => {
		const { db, pid, ctx } = await setup("active-override");
		const repoMap = new RepoMap(ctx, db, pid);

		// Index first so records exist
		await repoMap.updateIndex();

		// RELATIONAL: Mark as active (Model focus)
		await db.upsert_repo_map_file.run({
			project_id: pid,
			path: "active.js",
			visibility: "active",
			hash: null,
			size: 0,
		});
		await db.set_retained.run({
			project_id: pid,
			path: "active.js",
			is_retained: 1,
		});

		const perspective = await repoMap.renderPerspective({ sequence: 1 });

		const activeFile = perspective.files.find((f) => f.path === "active.js");
		assert.ok(activeFile, "active.js must be in perspective");
		assert.ok(
			activeFile.content,
			"Full content must be present for active files",
		);
	});

	it("8. Directed Warming: should warm up dependencies based on symbol matches", async () => {
		const { db, pid, ctx, testDir } = await setup("warming");

		await fs.mkdir(join(testDir, "deep/nested/dir"), { recursive: true });
		await fs.writeFile(
			join(testDir, "deep/nested/dir/lib.js"),
			"function targetSymbol() {}",
		);
		await fs.writeFile(
			join(testDir, "active.js"),
			"// Call the symbol\ntargetSymbol();",
		);

		const { execSync } = await import("node:child_process");
		execSync("git add .", { cwd: testDir });

		const newCtx = await ProjectContext.open(testDir);
		const repoMap = new RepoMap(newCtx, db, pid);

		// Index first
		await repoMap.updateIndex();

		// RELATIONAL: Mark caller as retained
		await db.set_retained.run({
			project_id: pid,
			path: "active.js",
			is_retained: 1,
		});

		const perspective = await repoMap.renderPerspective({ sequence: 1 });

		const lib = perspective.files.find(
			(f) => f.path === "deep/nested/dir/lib.js",
		);
		assert.ok(
			lib,
			"Deep dependency should be warmed up via relational heat join",
		);
		assert.strictEqual(
			lib.heat,
			1,
			"Warmed file heat should be 1 (one symbol overlap)",
		);
		assert.ok(
			lib.symbols && lib.symbols.length > 0,
			"Warmed dependency should include its symbols",
		);
		assert.strictEqual(lib.symbols[0].name, "targetSymbol");
	});

	it("9. Fidelity Decay: should omit content if last attention was > 12 turns ago", async () => {
		const { db, pid, ctx } = await setup("decay");
		const repoMap = new RepoMap(ctx, db, pid);

		await repoMap.updateIndex();

		// RELATIONAL: Mark as retained
		await db.set_retained.run({
			project_id: pid,
			path: "active.js",
			is_retained: 1,
		});

		// Set last_attention_turn to 1
		await db.update_file_attention.run({
			project_id: pid,
			turn_seq: 1,
			mention: "active.js",
		});

		// Render with sequence 14 (14 - 1 = 13, which is > 12)
		const perspective = await repoMap.renderPerspective({ sequence: 14 });

		const activeFile = perspective.files.find((f) => f.path === "active.js");
		assert.ok(activeFile, "active.js must be in perspective");
		assert.ok(
			!activeFile.content,
			"Content should be decayed (omitted) after 12 turns",
		);
		assert.ok(activeFile.symbols, "Should fall back to symbols");
	});
});
