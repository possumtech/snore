import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import createHooks from "../../src/domain/hooks/Hooks.js";
import ProjectContext from "../../src/domain/project/ProjectContext.js";
import RepoMap from "../../src/domain/repomap/RepoMap.js";
import TurnBuilder from "../../src/domain/turn/TurnBuilder.js";
import { registerPlugins } from "../../src/plugins/index.js";
import TestDb from "../helpers/TestDb.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function createTestProject(files = {}) {
	const projectPath = join(
		tmpdir(),
		`rummy-promo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await fs.mkdir(projectPath, { recursive: true });

	for (const [name, content] of Object.entries(files)) {
		await fs.writeFile(join(projectPath, name), content);
	}

	const { execSync } = await import("node:child_process");
	// Only git-track specific files, leave others untracked
	execSync(
		'git init && git config user.email "t@t" && git config user.name T',
		{ cwd: projectPath },
	);

	return projectPath;
}

async function setupDb(projectPath) {
	const tdb = await TestDb.create();
	const hooks = createHooks(false);
	const internalDir = join(__dirname, "../../src/application/plugins");
	const coreDir = join(__dirname, "../../src/plugins");
	await registerPlugins([internalDir, coreDir], hooks);

	await tdb.db.upsert_project.run({
		id: "p1",
		path: projectPath,
		name: "PromoTest",
	});
	await tdb.db.create_session.run({
		id: "s1",
		project_id: "p1",
		client_id: "c1",
	});
	await tdb.db.create_run.run({
		id: "r1",
		session_id: "s1",
		parent_run_id: null,
		type: "ask",
		config: "{}",
	});

	return { tdb, hooks };
}

async function indexProject(tdb, projectPath) {
	const ctx = await ProjectContext.open(projectPath);
	const repoMap = new RepoMap(ctx, tdb.db, "p1");
	await repoMap.updateIndex();
}

async function buildTurn(tdb, hooks, projectPath, seq = 0) {
	const turnRow = await tdb.db.create_empty_turn.get({
		run_id: "r1",
		sequence: seq,
	});
	const builder = new TurnBuilder(hooks);
	const turn = await builder.build({
		type: "ask",
		project: { id: "p1", path: projectPath, name: "PromoTest" },
		model: "test",
		db: tdb.db,
		prompt: "test",
		sequence: seq,
		hasUnknowns: true,
		turnId: turnRow.id,
		runId: "r1",
	});
	return turn;
}

function getSystemDocuments(turn) {
	const _msgs = [];
	const json = turn.toJson();
	return json.system;
}

describe("File Promotion Lifecycle", () => {
	it("activate on a git-tracked file should show full content in system", async () => {
		const projectPath = await createTestProject({
			"tracked.js": "const x = 1;\n",
		});
		const { execSync } = await import("node:child_process");
		execSync("git add tracked.js && git commit --no-verify -m 'feat: init'", {
			cwd: projectPath,
		});

		const { tdb, hooks } = await setupDb(projectPath);
		try {
			await indexProject(tdb, projectPath);

			await tdb.db.upsert_client_promotion.run({
				project_id: "p1",
				path: "tracked.js",
				constraint_type: "full",
			});

			const turn = await buildTurn(tdb, hooks, projectPath);
			const system = getSystemDocuments(turn);

			assert.ok(
				system.includes("tracked.js"),
				"System should reference tracked.js",
			);
			assert.ok(
				system.includes("const x = 1;"),
				"System should contain file content",
			);
		} finally {
			await tdb.cleanup();
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});

	it("activate on an UNTRACKED file should show full content in system", async () => {
		const projectPath = await createTestProject({
			"tracked.js": "const x = 1;\n",
			"GAMEPLAN.md": "# My Plan\nStep 1: do things\n",
		});
		const { execSync } = await import("node:child_process");
		execSync("git add tracked.js && git commit --no-verify -m 'feat: init'", {
			cwd: projectPath,
		});
		// GAMEPLAN.md is NOT git-tracked

		const { tdb, hooks } = await setupDb(projectPath);
		try {
			await indexProject(tdb, projectPath);

			// Client promotion is now path-based — no need to pre-index
			await tdb.db.upsert_client_promotion.run({
				project_id: "p1",
				path: "GAMEPLAN.md",
				constraint_type: "full",
			});

			await hooks.project.files.update.completed.emit({
				projectId: "p1",
				projectPath,
				pattern: "GAMEPLAN.md",
				constraint: "full",
				db: tdb.db,
			});

			const turn = await buildTurn(tdb, hooks, projectPath);
			const system = getSystemDocuments(turn);

			assert.ok(
				system.includes("GAMEPLAN.md"),
				`Untracked file should appear in system. System:\n${system.slice(0, 500)}`,
			);
			assert.ok(
				system.includes("My Plan"),
				`Untracked file content should be in system. System:\n${system.slice(0, 500)}`,
			);
		} finally {
			await tdb.cleanup();
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});

	it("readOnly should show content but mark as read-only", async () => {
		const projectPath = await createTestProject({
			"config.json": '{"key": "value"}\n',
		});
		const { execSync } = await import("node:child_process");
		execSync("git add config.json && git commit --no-verify -m 'feat: init'", {
			cwd: projectPath,
		});

		const { tdb, hooks } = await setupDb(projectPath);
		try {
			await indexProject(tdb, projectPath);

			await tdb.db.upsert_client_promotion.run({
				project_id: "p1",
				path: "config.json",
				constraint_type: "full:readonly",
			});

			const status = await tdb.db.get_repo_map_file.get({
				project_id: "p1",
				path: "config.json",
			});
			assert.strictEqual(status.client_constraint, "full:readonly");

			const turn = await buildTurn(tdb, hooks, projectPath);
			const system = getSystemDocuments(turn);

			assert.ok(
				system.includes("config.json"),
				"Read-only file should appear in system",
			);
			assert.ok(
				system.includes('"key"'),
				"Read-only file content should be present",
			);
		} finally {
			await tdb.cleanup();
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});

	it("ignore should exclude file from system entirely", async () => {
		const projectPath = await createTestProject({
			"secret.env": "API_KEY=hunter2\n",
			"main.js": "console.log('hi');\n",
		});
		const { execSync } = await import("node:child_process");
		execSync(
			"git add secret.env main.js && git commit --no-verify -m 'feat: init'",
			{ cwd: projectPath },
		);

		const { tdb, hooks } = await setupDb(projectPath);
		try {
			await indexProject(tdb, projectPath);

			await tdb.db.upsert_client_promotion.run({
				project_id: "p1",
				path: "secret.env",
				constraint_type: "excluded",
			});

			const turn = await buildTurn(tdb, hooks, projectPath);
			const system = getSystemDocuments(turn);

			assert.ok(
				!system.includes("secret.env"),
				"Ignored file should NOT appear in system",
			);
			assert.ok(
				!system.includes("hunter2"),
				"Ignored file content should NOT leak",
			);
			assert.ok(
				system.includes("main.js"),
				"Non-ignored files should still appear",
			);
		} finally {
			await tdb.cleanup();
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});

	it("drop should remove client promotion", async () => {
		const projectPath = await createTestProject({
			"main.js": "function hello() { return 'hi'; }\n",
		});
		const { execSync } = await import("node:child_process");
		execSync("git add main.js && git commit --no-verify -m 'feat: init'", {
			cwd: projectPath,
		});

		const { tdb, hooks } = await setupDb(projectPath);
		try {
			await indexProject(tdb, projectPath);

			// Activate then drop
			await tdb.db.upsert_client_promotion.run({
				project_id: "p1",
				path: "main.js",
				constraint_type: "full",
			});
			await tdb.db.delete_client_promotion.run({
				project_id: "p1",
				pattern: "main.js",
			});

			// Verify client promotion is gone
			const promos = await tdb.db.get_client_promotions.all({
				project_id: "p1",
			});
			assert.strictEqual(
				promos.filter((p) => p.path === "main.js").length,
				0,
				"Client promotion should be removed after drop",
			);

			// File should still appear in system (symbols or path)
			const turn = await buildTurn(tdb, hooks, projectPath);
			const system = getSystemDocuments(turn);
			assert.ok(
				system.includes("main.js"),
				"Dropped file should still appear in system",
			);
		} finally {
			await tdb.cleanup();
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});

	it("activate → ignore → fileStatus should reflect final state", async () => {
		const projectPath = await createTestProject({
			"flip.js": "let x = 1;\n",
		});
		const { execSync } = await import("node:child_process");
		execSync("git add flip.js && git commit --no-verify -m 'feat: init'", {
			cwd: projectPath,
		});

		const { tdb, hooks } = await setupDb(projectPath);
		try {
			await indexProject(tdb, projectPath);

			// Activate
			await tdb.db.upsert_client_promotion.run({
				project_id: "p1",
				path: "flip.js",
				constraint_type: "full",
			});

			let status = await tdb.db.get_repo_map_file.get({
				project_id: "p1",
				path: "flip.js",
			});
			assert.strictEqual(status.client_constraint, "full");

			// Override to ignore
			await tdb.db.upsert_client_promotion.run({
				project_id: "p1",
				path: "flip.js",
				constraint_type: "excluded",
			});

			status = await tdb.db.get_repo_map_file.get({
				project_id: "p1",
				path: "flip.js",
			});
			assert.strictEqual(status.client_constraint, "excluded");

			const turn = await buildTurn(tdb, hooks, projectPath);
			const system = getSystemDocuments(turn);

			assert.ok(
				!system.includes("flip.js"),
				"Overridden to excluded should not appear",
			);
		} finally {
			await tdb.cleanup();
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});
});
