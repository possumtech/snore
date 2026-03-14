import assert from "node:assert";
import fs from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import SqlRite from "@possumtech/sqlrite";

describe("Database Integration", () => {
	let db;
	const dbPath = "test_integration.db";

	before(async () => {
		await fs.unlink(dbPath).catch(() => {});
		db = await SqlRite.open({
			path: dbPath,
			dir: ["migrations", "src"],
		});
	});

	after(async () => {
		if (db) await db.close();
		await fs.unlink(dbPath).catch(() => {});
	});

	it("should have the get_models method prepared from src/agent/get_models.sql", async () => {
		const models = await db.get_models.all();
		assert.ok(Array.isArray(models));
		assert.ok(models.length >= 2);

		const gpt4o = models.find((m) => m.id === "gpt-4o");
		assert.strictEqual(gpt4o.name, "GPT-4o");
	});
});
