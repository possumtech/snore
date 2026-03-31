import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("Pattern operations integration", () => {
	let tdb, store;
	const RUN_ID = "run-pattern-1";

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);

		await tdb.db.upsert_project.run({
			id: "p1",
			path: "/tmp/test",
			name: "Test",
		});
		await tdb.db.create_session.run({
			id: "s1",
			project_id: "p1",
			client_id: "c1",
		});
		await tdb.db.create_run.run({
			id: RUN_ID,
			session_id: "s1",
			parent_run_id: null,
			type: "act",
			config: "{}",
			alias: "pattern_1",
		});

		// Seed files
		await store.upsert(RUN_ID, 0, "src/app.js", "const app = 1;", "full");
		await store.upsert(
			RUN_ID,
			0,
			"src/config.js",
			"const port = 3000;",
			"full",
		);
		await store.upsert(RUN_ID, 0, "src/utils.js", "// TODO: refactor", "full");
		await store.upsert(RUN_ID, 0, "readme.md", "# Hello", "full");

		// Seed knowledge
		await store.upsert(RUN_ID, 0, "known://auth_flow", "OAuth2 PKCE", "full");
		await store.upsert(RUN_ID, 0, "known://auth_secret", "hunter2", "full");
		await store.upsert(RUN_ID, 0, "known://db_type", "SQLite", "full");
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("getEntriesByPattern", () => {
		it("matches glob on path", async () => {
			const matches = await store.getEntriesByPattern(RUN_ID, "src/*.js", null);
			assert.strictEqual(matches.length, 3);
		});

		it("matches exact path", async () => {
			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"readme.md",
				null,
			);
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].path, "readme.md");
		});

		it("matches known keys with glob", async () => {
			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"known://auth_*",
				null,
			);
			assert.strictEqual(matches.length, 2);
		});

		it("filters by value pattern", async () => {
			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"src/*.js",
				"TODO",
			);
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].path, "src/utils.js");
		});

		it("path + value AND together", async () => {
			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"src/*.js",
				"const",
			);
			assert.strictEqual(matches.length, 2);
		});

		it("null value matches all", async () => {
			const matches = await store.getEntriesByPattern(RUN_ID, "*.md", null);
			assert.strictEqual(matches.length, 1);
		});

		it("includes tokens in results", async () => {
			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"src/app.js",
				null,
			);
			assert.ok(typeof matches[0].tokens === "number");
		});
	});

	describe("promoteByPattern", () => {
		it("promotes matching entries", async () => {
			await store.promoteByPattern(RUN_ID, "src/*.js", null, 5);
			const matches = await store.getEntriesByPattern(RUN_ID, "src/*.js", null);
			for (const m of matches) {
				const row = await tdb.db.get_entry_state.get({
					run_id: RUN_ID,
					path: m.path,
				});
				assert.strictEqual(row.turn, 5);
			}
		});

		it("promotes with value filter", async () => {
			await store.demoteByPattern(RUN_ID, "src/*.js", null);
			await store.promoteByPattern(RUN_ID, "src/*.js", "TODO", 7);
			const utils = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/utils.js",
			});
			const app = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/app.js",
			});
			assert.strictEqual(utils.turn, 7);
			assert.strictEqual(app.turn, 0);
		});
	});

	describe("demoteByPattern", () => {
		it("demotes matching entries", async () => {
			await store.promoteByPattern(RUN_ID, "src/*.js", null, 3);
			await store.demoteByPattern(RUN_ID, "src/*.js", null);
			const matches = await store.getEntriesByPattern(RUN_ID, "src/*.js", null);
			for (const m of matches) {
				const row = await tdb.db.get_entry_state.get({
					run_id: RUN_ID,
					path: m.path,
				});
				assert.strictEqual(row.turn, 0);
			}
		});
	});

	describe("deleteByPattern", () => {
		it("deletes matching entries", async () => {
			await store.upsert(RUN_ID, 0, "known://temp_a", "x", "full");
			await store.upsert(RUN_ID, 0, "known://temp_b", "y", "full");

			await store.deleteByPattern(RUN_ID, "known://temp_*", null);

			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"known://temp_*",
				null,
			);
			assert.strictEqual(matches.length, 0);
		});

		it("deletes with value filter", async () => {
			await store.upsert(RUN_ID, 0, "known://cache_a", "stale", "full");
			await store.upsert(RUN_ID, 0, "known://cache_b", "fresh", "full");

			await store.deleteByPattern(RUN_ID, "known://cache_*", "stale");

			const remaining = await store.getEntriesByPattern(
				RUN_ID,
				"known://cache_*",
				null,
			);
			assert.strictEqual(remaining.length, 1);
			assert.strictEqual(remaining[0].path, "known://cache_b");
		});
	});

	describe("updateValueByPattern", () => {
		it("bulk updates matching values", async () => {
			await store.upsert(RUN_ID, 0, "known://ver_a", "v1", "full");
			await store.upsert(RUN_ID, 0, "known://ver_b", "v1", "full");

			await store.updateValueByPattern(RUN_ID, "known://ver_*", null, "v2");

			const a = await store.getValue(RUN_ID, "known://ver_a");
			const b = await store.getValue(RUN_ID, "known://ver_b");
			assert.strictEqual(a, "v2");
			assert.strictEqual(b, "v2");
		});

		it("updates with value filter", async () => {
			await store.upsert(RUN_ID, 0, "known://status_a", "stale", "full");
			await store.upsert(RUN_ID, 0, "known://status_b", "fresh", "full");

			await store.updateValueByPattern(
				RUN_ID,
				"known://status_*",
				"stale",
				"refreshed",
			);

			const a = await store.getValue(RUN_ID, "known://status_a");
			const b = await store.getValue(RUN_ID, "known://status_b");
			assert.strictEqual(a, "refreshed");
			assert.strictEqual(b, "fresh");
		});
	});
});
