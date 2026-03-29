import assert from "node:assert";
import test from "node:test";
import TestDb from "../helpers/TestDb.js";

test("§8 Database Hygiene — purge operations", async (t) => {
	let tdb;

	t.before(async () => {
		tdb = await TestDb.create();
	});

	t.after(async () => await tdb.cleanup());

	await t.test("purge_old_runs query exists (PREP)", () => {
		assert.ok(
			typeof tdb.db.purge_old_runs?.run === "function",
			"purge_old_runs should be a prepared statement",
		);
	});

	await t.test("purge_stale_sessions query exists (EXEC)", () => {
		assert.ok(
			typeof tdb.db.purge_stale_sessions === "function",
			"purge_stale_sessions should be an exec statement",
		);
	});

	await t.test("purge_consumed_context query exists (EXEC)", () => {
		assert.ok(
			typeof tdb.db.purge_consumed_context === "function",
			"purge_consumed_context should be an exec statement",
		);
	});

	await t.test("purge_orphaned_editor_promotions query exists (EXEC)", () => {
		assert.ok(
			typeof tdb.db.purge_orphaned_editor_promotions === "function",
			"purge_orphaned_editor_promotions should be an exec statement",
		);
	});

	await t.test("purge_old_runs runs without error", async () => {
		await tdb.db.purge_old_runs.run({ retention_days: 31 });
		assert.ok(true, "purge_old_runs executed successfully");
	});
});
