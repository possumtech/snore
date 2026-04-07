import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("Pattern operations integration", () => {
	let tdb, store, RUN_ID;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun({ alias: "pattern_1" });
		RUN_ID = seed.runId;

		// Seed files
		await store.upsert(RUN_ID, 0, "src/app.js", "const app = 1;", 200);
		await store.upsert(RUN_ID, 0, "src/config.js", "const port = 3000;", 200);
		await store.upsert(RUN_ID, 0, "src/utils.js", "// TODO: refactor", 200);
		await store.upsert(RUN_ID, 0, "readme.md", "# Hello", 200);

		// Seed knowledge
		await store.upsert(RUN_ID, 0, "known://auth_flow", "OAuth2 PKCE", 200);
		await store.upsert(RUN_ID, 0, "known://auth_secret", "hunter2", 200);
		await store.upsert(RUN_ID, 0, "known://db_type", "SQLite", 200);
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

		it("includes tokens_full in results", async () => {
			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"src/app.js",
				null,
			);
			assert.ok(typeof matches[0].tokens_full === "number");
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
			assert.strictEqual(app.fidelity, "stored");
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
				assert.strictEqual(row.fidelity, "stored");
			}
		});
	});

	describe("deleteByPattern", () => {
		it("deletes matching entries", async () => {
			await store.upsert(RUN_ID, 0, "known://temp_a", "x", 200);
			await store.upsert(RUN_ID, 0, "known://temp_b", "y", 200);

			await store.deleteByPattern(RUN_ID, "known://temp_*", null);

			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"known://temp_*",
				null,
			);
			assert.strictEqual(matches.length, 0);
		});

		it("deletes with value filter", async () => {
			await store.upsert(RUN_ID, 0, "known://cache_a", "stale", 200);
			await store.upsert(RUN_ID, 0, "known://cache_b", "fresh", 200);

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

	describe("updateBodyByPattern", () => {
		it("bulk updates matching values", async () => {
			await store.upsert(RUN_ID, 0, "known://ver_a", "v1", 200);
			await store.upsert(RUN_ID, 0, "known://ver_b", "v1", 200);

			await store.updateBodyByPattern(RUN_ID, "known://ver_*", null, "v2");

			const a = await store.getBody(RUN_ID, "known://ver_a");
			const b = await store.getBody(RUN_ID, "known://ver_b");
			assert.strictEqual(a, "v2");
			assert.strictEqual(b, "v2");
		});

		it("updates with value filter", async () => {
			await store.upsert(RUN_ID, 0, "known://status_a", "stale", 200);
			await store.upsert(RUN_ID, 0, "known://status_b", "fresh", 200);

			await store.updateBodyByPattern(
				RUN_ID,
				"known://status_*",
				"stale",
				"refreshed",
			);

			const a = await store.getBody(RUN_ID, "known://status_a");
			const b = await store.getBody(RUN_ID, "known://status_b");
			assert.strictEqual(a, "refreshed");
			assert.strictEqual(b, "fresh");
		});
	});

	describe("search scheme", () => {
		it("search result can be stored and retrieved", async () => {
			await store.upsert(
				RUN_ID,
				1,
				"search://1",
				"1. SQLite WAL mode overview\n2. Write-Ahead Logging explained",
				200,
			);

			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"search://*",
				null,
			);
			assert.strictEqual(matches.length, 1);
			assert.strictEqual(matches[0].path, "search://1");
			assert.ok(matches[0].body.includes("WAL"));
		});
	});

	describe("search/replace edit mode", () => {
		it("literal search and replace on file content", async () => {
			await store.upsert(
				RUN_ID,
				1,
				"src/sr_test.js",
				"const host = 'localhost';\nconst port = 3000;\n",
				200,
			);

			const entries = await store.getEntriesByPattern(
				RUN_ID,
				"src/sr_test.js",
				null,
			);
			assert.strictEqual(entries.length, 1);

			const content = entries[0].body;
			const patched = content.replaceAll("localhost", "0.0.0.0");
			assert.ok(patched.includes("0.0.0.0"));
			assert.ok(!patched.includes("localhost"));
		});

		it("regex search on file content", async () => {
			const entries = await store.getEntriesByPattern(
				RUN_ID,
				"src/sr_test.js",
				null,
			);
			const content = entries[0].body;
			const re = /\d{4}/g;
			const patched = content.replace(re, "8080");
			assert.ok(patched.includes("8080"));
			assert.ok(!patched.includes("3000"));
		});

		it("search across multiple matching files", async () => {
			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"src/*.js",
				"const",
			);
			assert.ok(matches.length >= 2, "multiple files contain 'const'");
		});
	});
});
