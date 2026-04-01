import { readdirSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import SqlRite from "@possumtech/sqlrite";

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
		});
		return new TestDb(db, dbPath);
	}

	async seedRun({
		path = "/tmp/test",
		name = "Test",
		clientId = "c1",
		alias = "test_1",
	} = {}) {
		const project = await this.db.upsert_project.get({ path, name });
		const session = await this.db.create_session.get({
			project_id: project.id,
			client_id: clientId,
		});
		const run = await this.db.create_run.get({
			session_id: session.id,
			parent_run_id: null,
			config: "{}",
			alias,
		});
		return { projectId: project.id, sessionId: session.id, runId: run.id };
	}

	async cleanup() {
		await this.db.close();
		await fs.unlink(this.dbPath).catch(() => {});
		await fs.unlink(`${this.dbPath}-shm`).catch(() => {});
		await fs.unlink(`${this.dbPath}-wal`).catch(() => {});
	}
}
