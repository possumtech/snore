import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SqlRite from "@possumtech/sqlrite";

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
		// Scan both migrations and the new src structure for PREP/INIT tags
		const db = await SqlRite.open({
			path: dbPath,
			dir: ["migrations", "src"],
		});
		return new TestDb(db, dbPath);
	}

	async cleanup() {
		await this.db.close();
		await fs.unlink(this.dbPath).catch(() => {});
		await fs.unlink(`${this.dbPath}-shm`).catch(() => {});
		await fs.unlink(`${this.dbPath}-wal`).catch(() => {});
	}
}
