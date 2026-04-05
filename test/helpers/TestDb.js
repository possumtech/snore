import { readdirSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import SqlRite from "@possumtech/sqlrite";
import createHooks from "../../src/hooks/Hooks.js";
import { initPlugins, registerPlugins } from "../../src/plugins/index.js";
import RpcRegistry from "../../src/server/RpcRegistry.js";

const functionsDir = fileURLToPath(
	new URL("../../src/sql/functions", import.meta.url),
);
const sqlFunctions = readdirSync(functionsDir)
	.filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
	.map((f) => join(functionsDir, f));

export default class TestDb {
	constructor(db, dbPath) {
		this.db = db;
		this.dbPath = dbPath;
	}

	static async create() {
		const dbPath = join(
			tmpdir(),
			`rummy_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`,
		);
		const db = await SqlRite.open({
			path: dbPath,
			dir: ["migrations", "src"],
			functions: sqlFunctions,
			params: { mmap_size: 0 },
		});
		const hooks = createHooks();
		hooks.rpc.registry = new RpcRegistry();
		const pluginsDir = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../src/plugins",
		);
		await registerPlugins([pluginsDir], hooks);
		await initPlugins(db, null, hooks);
		return new TestDb(db, dbPath);
	}

	async seedRun({
		name = "Test",
		projectRoot = "/tmp/test",
		alias = "test_1",
	} = {}) {
		const project = await this.db.upsert_project.get({
			name,
			project_root: projectRoot,
			config_path: null,
		});
		const run = await this.db.create_run.get({
			project_id: project.id,
			parent_run_id: null,
			model: null,
			alias,
			temperature: null,
			persona: null,
			context_limit: null,
		});
		return { projectId: project.id, runId: run.id };
	}

	async seedModel({ alias = "test_model", actual = "test/model" } = {}) {
		const model = await this.db.upsert_model.get({
			alias,
			actual,
			context_length: 32000,
		});
		return { modelId: model.id };
	}

	async cleanup() {
		await this.db.close();
		await fs.unlink(this.dbPath).catch(() => {});
		await fs.unlink(`${this.dbPath}-shm`).catch(() => {});
		await fs.unlink(`${this.dbPath}-wal`).catch(() => {});
	}
}
