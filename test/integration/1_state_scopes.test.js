import assert from "node:assert";
import test from "node:test";
import TestDb from "../helpers/TestDb.js";

test("§1 State Scopes — promotion isolation", async (t) => {
	let tdb;

	t.before(async () => {
		tdb = await TestDb.create();
		await tdb.db.upsert_project.run({ id: "p1", path: "/tmp/scope-test", name: "ScopeTest" });
		await tdb.db.create_session.run({ id: "s1", project_id: "p1", client_id: "c1" });
		await tdb.db.create_run.run({
			id: "r1", session_id: "s1", parent_run_id: null,
			type: "ask", config: "{}", alias: "scope_1",
		});
		await tdb.db.create_run.run({
			id: "r2", session_id: "s1", parent_run_id: null,
			type: "ask", config: "{}", alias: "scope_2",
		});
		await tdb.db.upsert_repo_map_file.get({
			project_id: "p1", path: "src/a.js", hash: "abc", size: 100, symbol_tokens: 10,
		});
	});

	t.after(async () => await tdb.cleanup());

	await t.test("agent promotions are scoped to a run", async () => {
		const file = await tdb.db.get_repo_map_file.get({
			project_id: "p1", path: "src/a.js", run_id: "r1",
		});

		await tdb.db.upsert_agent_promotion.run({
			file_id: file.id, run_id: "r1", turn_seq: 0,
		});

		const inR1 = await tdb.db.get_repo_map_file.get({
			project_id: "p1", path: "src/a.js", run_id: "r1",
		});
		const inR2 = await tdb.db.get_repo_map_file.get({
			project_id: "p1", path: "src/a.js", run_id: "r2",
		});

		assert.strictEqual(inR1.has_agent_promotion, 1, "promoted in r1");
		assert.strictEqual(inR2.has_agent_promotion, 0, "not promoted in r2");
	});

	await t.test("client promotions are project-scoped, visible across runs", async () => {
		await tdb.db.upsert_client_promotion.run({
			project_id: "p1", path: "src/a.js", constraint_type: "full",
		});

		const inR1 = await tdb.db.get_repo_map_file.get({
			project_id: "p1", path: "src/a.js", run_id: "r1",
		});
		const inR2 = await tdb.db.get_repo_map_file.get({
			project_id: "p1", path: "src/a.js", run_id: "r2",
		});

		assert.strictEqual(inR1.client_constraint, "full", "visible in r1");
		assert.strictEqual(inR2.client_constraint, "full", "visible in r2");
	});

	await t.test("editor promotions have no run_id", async () => {
		const file = await tdb.db.get_repo_map_file.get({
			project_id: "p1", path: "src/a.js", run_id: "r1",
		});

		await tdb.db.upsert_editor_promotion.run({
			project_id: "p1", path: "src/a.js",
		});

		const after = await tdb.db.get_repo_map_file.get({
			project_id: "p1", path: "src/a.js", run_id: "r1",
		});
		assert.strictEqual(after.has_editor_promotion, 1, "editor promotion present");

		// Clean up
		await tdb.db.reset_editor_promotions.run({ project_id: "p1" });
		const cleared = await tdb.db.get_repo_map_file.get({
			project_id: "p1", path: "src/a.js", run_id: "r1",
		});
		assert.strictEqual(cleared.has_editor_promotion, 0, "editor promotion cleared");
	});
});
