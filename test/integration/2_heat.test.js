import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import ProjectContext from "../../src/domain/project/ProjectContext.js";
import RepoMap from "../../src/domain/repomap/RepoMap.js";
import TestDb from "../helpers/TestDb.js";

async function createTestProject(files) {
	const projectPath = join(
		tmpdir(),
		`rummy-xref-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await fs.mkdir(projectPath, { recursive: true });

	for (const [name, content] of Object.entries(files)) {
		await fs.writeFile(join(projectPath, name), content);
	}

	const { execSync } = await import("node:child_process");
	execSync(
		'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
		{ cwd: projectPath },
	);
	return projectPath;
}

describe("Cross-Reference Population", () => {
	it("should populate references when file B mentions symbols from file A", async () => {
		const projectPath = await createTestProject({
			"utils.js":
				"export function calculateTotal(items) {\n\treturn items.reduce((sum, i) => sum + i.price, 0);\n}\n\nexport function formatCurrency(amount) {\n\treturn `$${amount.toFixed(2)}`;\n}\n",
			"app.js":
				"import { calculateTotal, formatCurrency } from './utils.js';\n\nconst total = calculateTotal(cart);\nconsole.log(formatCurrency(total));\n",
		});

		const tdb = await TestDb.create();
		try {
			await tdb.db.upsert_project.run({
				id: "p1",
				path: projectPath,
				name: "XRefTest",
			});

			const ctx = await ProjectContext.open(projectPath);
			const repoMap = new RepoMap(ctx, tdb.db, "p1");
			await repoMap.updateIndex();

			// Check that references were created
			const refs = await tdb.db.get_project_repo_map.all({
				project_id: "p1",
			});

			// Build file ID map
			const fileIds = new Map();
			for (const row of refs) {
				if (!fileIds.has(row.path)) fileIds.set(row.path, row.id);
			}

			const appId = fileIds.get("app.js");
			assert.ok(appId, "app.js should be indexed");

			// Query references directly
			const appRefs = await tdb.db.get_file_references.all({ file_id: appId });

			const refNames = appRefs.map((r) => r.symbol_name);
			assert.ok(
				refNames.includes("calculateTotal"),
				`app.js should reference calculateTotal. Got: ${JSON.stringify(refNames)}`,
			);
			assert.ok(
				refNames.includes("formatCurrency"),
				`app.js should reference formatCurrency. Got: ${JSON.stringify(refNames)}`,
			);
		} finally {
			await tdb.cleanup();
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});

	it("should not create self-references", async () => {
		const projectPath = await createTestProject({
			"math.js":
				"export function add(a, b) {\n\treturn a + b;\n}\n\nconst result = add(1, 2);\n",
		});

		const tdb = await TestDb.create();
		try {
			await tdb.db.upsert_project.run({
				id: "p1",
				path: projectPath,
				name: "SelfRefTest",
			});

			const ctx = await ProjectContext.open(projectPath);
			const repoMap = new RepoMap(ctx, tdb.db, "p1");
			await repoMap.updateIndex();

			const files = await tdb.db.get_project_repo_map.all({
				project_id: "p1",
			});
			const mathId = files.find((f) => f.path === "math.js")?.id;
			assert.ok(mathId, "math.js should be indexed");

			const selfRefs = await tdb.db.get_file_references.all({
				file_id: mathId,
			});

			assert.strictEqual(
				selfRefs.length,
				0,
				`math.js should not have self-references. Got: ${JSON.stringify(selfRefs.map((r) => r.symbol_name))}`,
			);
		} finally {
			await tdb.cleanup();
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});

	it("should skip short symbol names (< 3 chars)", async () => {
		const projectPath = await createTestProject({
			"defs.js":
				"export const id = 1;\nexport function go() {}\nexport class UserService {}\n",
			"consumer.js": "const x = id;\ngo();\nconst svc = new UserService();\n",
		});

		const tdb = await TestDb.create();
		try {
			await tdb.db.upsert_project.run({
				id: "p1",
				path: projectPath,
				name: "ShortNameTest",
			});

			const ctx = await ProjectContext.open(projectPath);
			const repoMap = new RepoMap(ctx, tdb.db, "p1");
			await repoMap.updateIndex();

			const files = await tdb.db.get_project_repo_map.all({
				project_id: "p1",
			});
			const consumerId = files.find((f) => f.path === "consumer.js")?.id;
			assert.ok(consumerId, "consumer.js should be indexed");

			const refs = await tdb.db.get_file_references.all({
				file_id: consumerId,
			});
			const refNames = refs.map((r) => r.symbol_name);

			assert.ok(
				!refNames.includes("id"),
				`"id" (2 chars) should be filtered out. Got: ${JSON.stringify(refNames)}`,
			);
			assert.ok(
				!refNames.includes("go"),
				`"go" (2 chars) should be filtered out. Got: ${JSON.stringify(refNames)}`,
			);
			assert.ok(
				refNames.includes("UserService"),
				`"UserService" should be present. Got: ${JSON.stringify(refNames)}`,
			);
		} finally {
			await tdb.cleanup();
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});

	it("heat should increase when a promoted file references another file's symbols", async () => {
		const projectPath = await createTestProject({
			"config.js":
				"export const DATABASE_URL = 'postgres://localhost/app';\nexport const MAX_RETRIES = 3;\n",
			"server.js":
				"import { DATABASE_URL, MAX_RETRIES } from './config.js';\nconsole.log(DATABASE_URL, MAX_RETRIES);\n",
		});

		const tdb = await TestDb.create();
		try {
			await tdb.db.upsert_project.run({
				id: "p1",
				path: projectPath,
				name: "HeatTest",
			});
			await tdb.db.create_session.run({
				id: "s1",
				project_id: "p1",
				client_id: "test",
			});
			await tdb.db.create_run.run({
				id: "r1",
				session_id: "s1",
				parent_run_id: null,
				type: "ask",
				config: "{}",
				alias: "test_1",
			});

			const ctx = await ProjectContext.open(projectPath);
			const repoMap = new RepoMap(ctx, tdb.db, "p1");
			await repoMap.updateIndex();

			// Promote server.js as agent file
			const files = await tdb.db.get_project_repo_map.all({
				project_id: "p1",
			});
			const serverId = files.find((f) => f.path === "server.js")?.id;
			await tdb.db.upsert_agent_promotion.run({
				file_id: serverId,
				run_id: "r1",
				turn_seq: 0,
			});

			// Check heat via ranked query
			const ranked = await tdb.db.get_ranked_repo_map.all({
				project_id: "p1",
				run_id: "r1",
			});

			const configRanked = ranked.find((f) => f.path === "config.js");
			assert.ok(configRanked, "config.js should appear in ranked results");
			assert.ok(
				configRanked.heat >= 2,
				`config.js heat should be >= 2 (cross-referenced by promoted server.js). Got: ${configRanked.heat}`,
			);
		} finally {
			await tdb.cleanup();
			await fs.rm(projectPath, { recursive: true, force: true });
		}
	});
});
