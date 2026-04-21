import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("Pattern operations integration", () => {
	let tdb, store, RUN_ID;

	before(async () => {
		tdb = await TestDb.create();
		store = new Entries(tdb.db);
		const seed = await tdb.seedRun({ alias: "pattern_1" });
		RUN_ID = seed.runId;

		// Seed files
		await store.set({
			runId: RUN_ID,
			turn: 0,
			path: "src/app.js",
			body: "const app = 1;",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 0,
			path: "src/config.js",
			body: "const port = 3000;",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 0,
			path: "src/utils.js",
			body: "// TODO: refactor",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 0,
			path: "readme.md",
			body: "# Hello",
			state: "resolved",
		});

		// Seed knowledge
		await store.set({
			runId: RUN_ID,
			turn: 0,
			path: "known://auth_flow",
			body: "OAuth2 PKCE",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 0,
			path: "known://auth_secret",
			body: "hunter2",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 0,
			path: "known://db_type",
			body: "SQLite",
			state: "resolved",
		});
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
			await store.get({
				runId: RUN_ID,
				turn: 5,
				path: "src/*.js",
				pattern: true,
			});
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
			await store.set({
				runId: RUN_ID,
				path: "src/*.js",
				fidelity: "demoted",
				pattern: true,
			});
			await store.get({
				runId: RUN_ID,
				turn: 7,
				path: "src/*.js",
				bodyFilter: "TODO",
			});
			const utils = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/utils.js",
			});
			const app = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/app.js",
			});
			assert.strictEqual(utils.turn, 7);
			assert.strictEqual(app.fidelity, "archived");
		});
	});

	describe("demoteByPattern", () => {
		it("demotes matching entries", async () => {
			await store.get({
				runId: RUN_ID,
				turn: 3,
				path: "src/*.js",
				pattern: true,
			});
			await store.set({
				runId: RUN_ID,
				path: "src/*.js",
				fidelity: "demoted",
				pattern: true,
			});
			const matches = await store.getEntriesByPattern(RUN_ID, "src/*.js", null);
			for (const m of matches) {
				const row = await tdb.db.get_entry_state.get({
					run_id: RUN_ID,
					path: m.path,
				});
				assert.strictEqual(row.fidelity, "archived");
			}
		});
	});

	describe("deleteByPattern", () => {
		it("deletes matching entries", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://temp_a",
				body: "x",
				state: "resolved",
			});
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://temp_b",
				body: "y",
				state: "resolved",
			});

			await store.rm({
				runId: RUN_ID,
				path: "known://temp_*",
				pattern: true,
			});

			const matches = await store.getEntriesByPattern(
				RUN_ID,
				"known://temp_*",
				null,
			);
			assert.strictEqual(matches.length, 0);
		});

		it("deletes with value filter", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://cache_a",
				body: "stale",
				state: "resolved",
			});
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://cache_b",
				body: "fresh",
				state: "resolved",
			});

			await store.rm({
				runId: RUN_ID,
				path: "known://cache_*",
				bodyFilter: "stale",
			});

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
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://ver_a",
				body: "v1",
				state: "resolved",
			});
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://ver_b",
				body: "v1",
				state: "resolved",
			});

			await store.set({
				runId: RUN_ID,
				path: "known://ver_*",
				body: "v2",
				pattern: true,
			});

			const a = await store.getBody(RUN_ID, "known://ver_a");
			const b = await store.getBody(RUN_ID, "known://ver_b");
			assert.strictEqual(a, "v2");
			assert.strictEqual(b, "v2");
		});

		it("updates with value filter", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://status_a",
				body: "stale",
				state: "resolved",
			});
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://status_b",
				body: "fresh",
				state: "resolved",
			});

			await store.set({
				runId: RUN_ID,
				path: "known://status_*",
				body: "refreshed",
				bodyFilter: "stale",
			});

			const a = await store.getBody(RUN_ID, "known://status_a");
			const b = await store.getBody(RUN_ID, "known://status_b");
			assert.strictEqual(a, "refreshed");
			assert.strictEqual(b, "fresh");
		});
	});

	describe("search scheme", () => {
		it("search result can be stored and retrieved", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "search://1",
				body: "1. SQLite WAL mode overview\n2. Write-Ahead Logging explained",
				state: "resolved",
			});

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
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/sr_test.js",
				body: "const host = 'localhost';\nconst port = 3000;\n",
				state: "resolved",
			});

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
