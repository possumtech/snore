import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("KnownStore integration", () => {
	let tdb;
	let store;
	let RUN_ID;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun({ alias: "test_1" });
		RUN_ID = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("scheme extraction", () => {
		it("bare paths have null scheme", () => {
			assert.strictEqual(KnownStore.scheme("src/app.js"), null);
			assert.strictEqual(KnownStore.scheme("package.json"), null);
		});

		it("known:// scheme", () => {
			assert.strictEqual(KnownStore.scheme("known://auth_flow"), "known");
		});

		it("tool schemes", () => {
			assert.strictEqual(KnownStore.scheme("read://4"), "read");
			assert.strictEqual(KnownStore.scheme("write://7"), "write");
			assert.strictEqual(KnownStore.scheme("summary://1"), "summary");
		});

		it("unknown:// scheme", () => {
			assert.strictEqual(KnownStore.scheme("unknown://1"), "unknown");
			assert.strictEqual(KnownStore.scheme("unknown://42"), "unknown");
		});
	});

	describe("toolFromPath", () => {
		it("extracts tool name from result keys", () => {
			assert.strictEqual(KnownStore.toolFromPath("read://4"), "read");
			assert.strictEqual(KnownStore.toolFromPath("write://7"), "write");
			assert.strictEqual(KnownStore.toolFromPath("summary://1"), "summary");
		});

		it("returns null for bare file paths", () => {
			assert.strictEqual(KnownStore.toolFromPath("src/app.js"), null);
		});

		it("returns 'known' for known:// keys", () => {
			assert.strictEqual(KnownStore.toolFromPath("known://auth"), "known");
		});
	});

	describe("isSystemPath", () => {
		it("detects /: prefix", () => {
			assert.ok(KnownStore.isSystemPath("known://x"));
			assert.ok(KnownStore.isSystemPath("read://1"));
			assert.ok(!KnownStore.isSystemPath("src/app.js"));
		});
	});

	describe("upsert and getAll", () => {
		it("inserts a file entry", async () => {
			await store.upsert(RUN_ID, 0, "src/app.js", "const x = 1;", "full");
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "src/app.js");
			assert.ok(entry);
			assert.strictEqual(entry.scheme, null);
			assert.strictEqual(entry.state, "full");
			assert.strictEqual(entry.value, "const x = 1;");
		});

		it("inserts a knowledge entry", async () => {
			await store.upsert(RUN_ID, 0, "known://db_type", "SQLite", "full");
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "known://db_type");
			assert.ok(entry);
			assert.strictEqual(entry.scheme, "known");
			assert.strictEqual(entry.state, "full");
		});

		it("inserts a result entry", async () => {
			await store.upsert(RUN_ID, 1, "read://1", "file contents", "pass", {
				meta: { command: "read src/app.js" },
			});
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "read://1");
			assert.ok(entry);
			assert.strictEqual(entry.scheme, "read");
			assert.strictEqual(entry.state, "pass");
			assert.ok(entry.meta);
			const meta = JSON.parse(entry.meta);
			assert.strictEqual(meta.command, "read src/app.js");
		});

		it("upsert overwrites value on conflict", async () => {
			await store.upsert(RUN_ID, 0, "known://db_type", "PostgreSQL", "full");
			const rows = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = rows.find((e) => e.path === "known://db_type");
			assert.strictEqual(entry.value, "PostgreSQL");
		});

		it("upsert preserves meta when new meta is null", async () => {
			await store.upsert(RUN_ID, 0, "read://1", "updated", "pass");
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "read://1");
			assert.ok(entry.meta, "meta should be preserved from first write");
		});
	});

	describe("remove", () => {
		it("deletes an entry", async () => {
			await store.upsert(RUN_ID, 0, "known://temp", "temporary", "full");
			let all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			assert.ok(all.find((e) => e.path === "known://temp"));

			await store.remove(RUN_ID, "known://temp");
			all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			assert.ok(!all.find((e) => e.path === "known://temp"));
		});
	});

	describe("resolve", () => {
		it("changes proposed to pass with output", async () => {
			await store.upsert(RUN_ID, 1, "write://1", "", "proposed", {
				meta: { file: "src/app.js", search: "old", replace: "new" },
			});
			const unresolved = await store.getUnresolved(RUN_ID);
			assert.strictEqual(unresolved.length, 1);
			assert.strictEqual(unresolved[0].path, "write://1");

			await store.resolve(RUN_ID, "write://1", "pass", "edit applied");
			const after = await store.getUnresolved(RUN_ID);
			assert.strictEqual(after.length, 0);

			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "write://1");
			assert.strictEqual(entry.state, "pass");
			assert.strictEqual(entry.value, "edit applied");
		});

		it("changes proposed to warn on rejection", async () => {
			await store.upsert(RUN_ID, 1, "run://1", "", "proposed", {
				meta: { command: "npm test" },
			});
			await store.resolve(RUN_ID, "run://1", "warn", "rejected by user");

			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "run://1");
			assert.strictEqual(entry.state, "warn");
		});
	});

	describe("promote and demote", () => {
		it("promote sets turn to current", async () => {
			await store.upsert(RUN_ID, 0, "src/promoted.js", "content", "full");
			let row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/promoted.js",
			});
			assert.strictEqual(row.turn, 0);

			await store.promote(RUN_ID, "src/promoted.js", 10);
			row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/promoted.js",
			});
			assert.strictEqual(row.turn, 10);
		});

		it("demote sets turn to 0", async () => {
			await store.upsert(RUN_ID, 10, "src/demoted.js", "content", "full");
			await store.demote(RUN_ID, "src/demoted.js");

			const row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/demoted.js",
			});
			assert.strictEqual(row.turn, 0);
		});
	});

	describe("slug path generation", () => {
		it("generates content-derived slugs", async () => {
			const key1 = await store.slugPath(RUN_ID, "read", "src/app.js");
			assert.strictEqual(key1, "read://srcappjs");
		});

		it("handles collisions with integer suffix", async () => {
			await store.upsert(RUN_ID, 1, "read://srcappjs", "", "pass");
			const key2 = await store.slugPath(RUN_ID, "read", "src/app.js");
			assert.strictEqual(key2, "read://srcappjs2");
		});

		it("falls back to sequential for empty content", async () => {
			const key1 = await store.slugPath(RUN_ID, "env", "");
			assert.match(key1, /^env:\/\/\d+$/);
		});
	});

	describe("turn generation", () => {
		it("generates sequential turn numbers starting at 1", async () => {
			const t1 = await store.nextTurn(RUN_ID);
			const t2 = await store.nextTurn(RUN_ID);
			const t3 = await store.nextTurn(RUN_ID);

			assert.strictEqual(t1, 1);
			assert.strictEqual(t2, 2);
			assert.strictEqual(t3, 3);
		});
	});

	describe("log", () => {
		it("returns result-domain entries in chronological order", async () => {
			const log = await store.getLog(RUN_ID);
			assert.ok(log.length > 0);

			// All entries should have tool, target, status, key, value
			for (const entry of log) {
				assert.ok("tool" in entry);
				assert.ok("target" in entry);
				assert.ok("status" in entry);
				assert.ok("path" in entry);
				assert.ok("value" in entry);
			}
		});

		it("derives tool name from key prefix", async () => {
			const log = await store.getLog(RUN_ID);
			const readEntry = log.find((e) => e.path.startsWith("read://"));
			assert.strictEqual(readEntry.tool, "read");
		});

		it("derives target from meta", async () => {
			const log = await store.getLog(RUN_ID);
			const editEntry = log.find((e) => e.path === "write://1");
			assert.ok(editEntry);
			assert.strictEqual(editEntry.target, "src/app.js");
		});
	});

	describe("delete resolution", () => {
		it("accept erases the target file key from store", async () => {
			// Setup: file exists in store
			await store.upsert(RUN_ID, 1, "src/doomed.js", "content", "full");
			const before = await store.getValue(RUN_ID, "src/doomed.js");
			assert.strictEqual(before, "content");

			// Setup: proposed delete entry targeting that file
			await store.upsert(RUN_ID, 1, "delete://50", "", "proposed", {
				meta: { path: "src/doomed.js" },
			});

			// Resolve: accept the delete
			await store.resolve(RUN_ID, "delete://50", "pass", "");

			// Verify: target file key is gone — use resolve to check meta, then remove
			const meta = await store.getMeta(RUN_ID, "delete://50");
			assert.strictEqual(meta.path, "src/doomed.js");
			await store.remove(RUN_ID, meta.path);

			const after = await store.getValue(RUN_ID, "src/doomed.js");
			assert.strictEqual(
				after,
				null,
				"target file should be removed from store",
			);
		});

		it("reject preserves the target file key", async () => {
			// Setup: file exists
			await store.upsert(RUN_ID, 1, "src/survivor.js", "alive", "full");

			// Setup: proposed delete
			await store.upsert(RUN_ID, 1, "delete://51", "", "proposed", {
				meta: { path: "src/survivor.js" },
			});

			// Resolve: reject
			await store.resolve(RUN_ID, "delete://51", "warn", "rejected");

			// Verify: file still exists
			const value = await store.getValue(RUN_ID, "src/survivor.js");
			assert.strictEqual(
				value,
				"alive",
				"target file should survive rejection",
			);
		});
	});

	describe("scheme CHECK constraint", () => {
		it("rejects invalid file state", async () => {
			await assert.rejects(
				() => store.upsert(RUN_ID, 0, "bad.js", "", "proposed"),
				/invalid state for scheme/,
			);
		});

		it("rejects invalid known state", async () => {
			await assert.rejects(
				() => store.upsert(RUN_ID, 0, "known://bad", "", "proposed"),
				/invalid state for scheme/,
			);
		});

		it("rejects invalid edit state", async () => {
			await assert.rejects(
				() => store.upsert(RUN_ID, 0, "write://999", "", "full"),
				/invalid state for scheme/,
			);
		});
	});
});
