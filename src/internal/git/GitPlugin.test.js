import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import SqlRite from "@possumtech/sqlrite";
import HookRegistry from "../../../core/HookRegistry.js";
import GitPlugin from "./GitPlugin.js";

describe("GitPlugin (Delta Engine)", () => {
	let db;
	const dbPath = "test_git_plugin.db";
	const testDir = join(process.cwd(), "test_git_plugin_dir");

	before(async () => {
		await fs.mkdir(testDir, { recursive: true });
		await fs.writeFile(join(testDir, "file.js"), "original content");
		db = await SqlRite.open({ path: dbPath, dir: ["migrations", "src"] });
	});

	after(async () => {
		await db.close();
		await fs.unlink(dbPath).catch(() => {});
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("should only list modified files", async () => {
		const hooks = new HookRegistry();
		GitPlugin.register(hooks);

		const projectId = "p1";
		await db.upsert_project.run({ id: projectId, path: testDir, name: "Test" });

		await db.upsert_repo_map_file.run({
			project_id: projectId,
			path: "file.js",
			visibility: "mappable",
			size: 10,
			hash: "STALE_HASH",
		});

		const slot = { add: mock.fn() };
		await hooks.doAction("TURN_CONTEXT_GIT_CHANGES", slot, {
			project: { id: projectId, path: testDir },
			db,
		});

		assert.strictEqual(slot.add.mock.callCount(), 1);
		assert.ok(
			slot.add.mock.calls[0].arguments[0].includes("Modified: file.js"),
		);
	});

	it("should emit nothing if hashes match", async () => {
		const hooks = new HookRegistry();
		GitPlugin.register(hooks);

		const content = await fs.readFile(join(testDir, "file.js"), "utf8");
		const currentHash = crypto
			.createHash("sha256")
			.update(content)
			.digest("hex");

		await db.upsert_repo_map_file.run({
			project_id: "p1",
			path: "file.js",
			visibility: "mappable",
			size: content.length,
			hash: currentHash,
		});

		const slot = { add: mock.fn() };
		await hooks.doAction("TURN_CONTEXT_GIT_CHANGES", slot, {
			project: { id: "p1", path: testDir },
			db,
		});

		assert.strictEqual(slot.add.mock.callCount(), 0);
	});
});
