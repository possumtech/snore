import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import TestDb from "../helpers/TestDb.js";

describe("Database Integration: Models", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("db_models");
	});

	after(async () => {
		if (tdb) await tdb.cleanup();
	});

	it("should allow inserting and retrieving models", async () => {
		await tdb.db.insert_model.run({
			id: "test-model",
			name: "Test Model",
			description: "A model for testing",
		});

		const models = await tdb.db.get_models.all();
		assert.ok(Array.isArray(models));
		assert.ok(models.some((m) => m.id === "test-model"));

		const m = models.find((m) => m.id === "test-model");
		assert.strictEqual(m.name, "Test Model");
	});
});
