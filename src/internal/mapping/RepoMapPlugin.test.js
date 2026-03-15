import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import SqlRite from "@possumtech/sqlrite";
import HookRegistry from "../../core/HookRegistry.js";
import RepoMapPlugin from "./RepoMapPlugin.js";

describe("RepoMapPlugin", () => {
	let db;
	const dbPath = "test_repomap_plugin.db";
	const testDir = join(process.cwd(), "test_repomap_plugin_dir");

	before(async () => {
		await fs.mkdir(testDir, { recursive: true });
		await fs.writeFile(join(testDir, "active.js"), "console.log('hello');");
		db = await SqlRite.open({ path: dbPath, dir: ["migrations", "src"] });
	});

	after(async () => {
		await db.close();
		await fs.unlink(dbPath).catch(() => {});
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("should register hooks and populate files slot", async () => {
		const hooks = new HookRegistry();
		RepoMapPlugin.register(hooks);

		const projectId = "p1";
		await db.upsert_project.run({ id: projectId, path: testDir, name: "Test" });
		await db.upsert_repo_map_file.run({
			project_id: projectId,
			path: "active.js",
			visibility: "active",
			size: 10,
			hash: "h1",
		});

		const slot = { add: mock.fn() };
		const project = { id: projectId, path: testDir };

		await hooks.doAction("TURN_CONTEXT_FILES", slot, {
			project,
			activeFiles: ["active.js"],
			db,
		});

		assert.ok(slot.add.mock.callCount() >= 1);
		const firstCall = slot.add.mock.calls[0].arguments[0];
		assert.strictEqual(firstCall.path, "active.js");
		assert.ok(firstCall.content.includes("console.log"));
	});
});
