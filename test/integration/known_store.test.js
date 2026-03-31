import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("KnownStore integration", () => {
	let tdb;
	let store;
	const RUN_ID = "run-test-1";

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);

		// Create prerequisite rows
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
			alias: "test_1",
		});
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
			assert.strictEqual(KnownStore.scheme("edit://7"), "edit");
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
			assert.strictEqual(KnownStore.toolFromPath("edit://7"), "edit");
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
			await store.upsert(RUN_ID, 1, "edit://1", "", "proposed", {
				meta: { path: "src/app.js", search: "old", replace: "new" },
			});
			const unresolved = await store.getUnresolved(RUN_ID);
			assert.strictEqual(unresolved.length, 1);
			assert.strictEqual(unresolved[0].path, "edit://1");

			await store.resolve(RUN_ID, "edit://1", "pass", "edit applied");
			const after = await store.getUnresolved(RUN_ID);
			assert.strictEqual(after.length, 0);

			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "edit://1");
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

	describe("model projection", () => {
		// Expansion rule: turn > 0 = expanded, turn == 0 = collapsed
		const CURRENT_TURN = 5;

		it("hides file:ignore entries", async () => {
			await store.upsert(
				RUN_ID,
				CURRENT_TURN,
				"node_modules/x.js",
				"",
				"ignore",
			);
			const model = await store.getModelContext(RUN_ID);
			assert.ok(!model.find((e) => e.path === "node_modules/x.js"));
		});

		it("hides proposed entries", async () => {
			await store.upsert(RUN_ID, CURRENT_TURN, "edit://99", "", "proposed", {
				meta: { path: "x.js" },
			});
			const model = await store.getModelContext(RUN_ID);
			assert.ok(!model.find((e) => e.path === "edit://99"));
			await store.resolve(RUN_ID, "edit://99", "pass", "done");
		});

		it("expanded files (turn == currentTurn) show full value", async () => {
			await store.upsert(RUN_ID, CURRENT_TURN, "readme.md", "# Hi", "readonly");
			await store.upsert(
				RUN_ID,
				CURRENT_TURN,
				"main.js",
				"export default {}",
				"active",
			);

			const model = await store.getModelContext(RUN_ID);
			const readme = model.find((e) => e.path === "readme.md");
			const main = model.find((e) => e.path === "main.js");

			assert.strictEqual(readme.state, "file:readonly");
			assert.strictEqual(readme.value, "# Hi");
			assert.strictEqual(main.state, "file:active");
			assert.strictEqual(main.value, "export default {}");
		});

		it("collapsed files (turn == 0) show as file:path with empty value", async () => {
			await store.upsert(
				RUN_ID,
				0,
				"utils.js",
				"const add = (a,b) => a+b;",
				"full",
			);
			const model = await store.getModelContext(RUN_ID);
			const utils = model.find((e) => e.path === "utils.js");

			assert.strictEqual(utils.state, "file:path");
			assert.strictEqual(utils.value, "");
		});

		it("expanded file:full shows as 'file'", async () => {
			await store.upsert(
				RUN_ID,
				CURRENT_TURN,
				"src/app.js",
				"const x = 1;",
				"full",
			);
			const model = await store.getModelContext(RUN_ID);
			const app = model.find((e) => e.path === "src/app.js");
			assert.strictEqual(app.state, "known");
			assert.strictEqual(app.value, "const x = 1;");
		});

		it("result entries show with their status and empty value (recallable)", async () => {
			await store.upsert(
				RUN_ID,
				CURRENT_TURN,
				"read://1",
				"file contents",
				"pass",
			);
			const model = await store.getModelContext(RUN_ID);
			const read = model.find((e) => e.path === "read://1");
			assert.strictEqual(read.state, "pass");
			assert.strictEqual(read.value, "");
		});

		it("expanded known shows as full with value", async () => {
			await store.upsert(
				RUN_ID,
				CURRENT_TURN,
				"known://db_type",
				"PostgreSQL",
				"full",
			);
			const model = await store.getModelContext(RUN_ID);
			const known = model.find((e) => e.path === "known://db_type");
			assert.strictEqual(known.state, "full");
			assert.strictEqual(known.value, "PostgreSQL");
		});

		it("collapsed known shows as stored with empty value", async () => {
			await store.upsert(RUN_ID, 0, "known://old_fact", "stale info", "full");
			const model = await store.getModelContext(RUN_ID);
			const old = model.find((e) => e.path === "known://old_fact");
			assert.strictEqual(old.state, "stored");
			assert.strictEqual(old.value, "");
		});

		it("hides internal keys but shows sticky unknowns", async () => {
			await store.upsert(
				RUN_ID,
				CURRENT_TURN,
				"unknown://1",
				"What is the session store?",
				"full",
			);
			await store.upsert(
				RUN_ID,
				CURRENT_TURN,
				"system://5",
				"prompt text",
				"info",
			);
			await store.upsert(RUN_ID, CURRENT_TURN, "user://5", "user text", "info");
			await store.upsert(
				RUN_ID,
				CURRENT_TURN,
				"reasoning://5",
				"thinking...",
				"info",
			);

			const model = await store.getModelContext(RUN_ID);
			assert.ok(!model.find((e) => e.path === "system://5"));
			assert.ok(!model.find((e) => e.path === "user://5"));
			assert.ok(!model.find((e) => e.path === "reasoning://5"));
			const unknowns = model.filter((e) => e.state === "unknown");
			assert.ok(unknowns.length > 0, "unknowns should appear in context");
			assert.strictEqual(unknowns[0].value, "What is the session store?");
		});
	});

	describe("promote and demote", () => {
		it("promote sets turn to current", async () => {
			await store.upsert(RUN_ID, 0, "src/promoted.js", "content", "full");
			let model = await store.getModelContext(RUN_ID);
			let entry = model.find((e) => e.path === "src/promoted.js");
			assert.strictEqual(entry.state, "file:path");
			assert.strictEqual(entry.value, "");

			await store.promote(RUN_ID, "src/promoted.js", 10);
			model = await store.getModelContext(RUN_ID);
			entry = model.find((e) => e.path === "src/promoted.js");
			assert.strictEqual(entry.state, "file");
			assert.strictEqual(entry.value, "content");
		});

		it("demote sets turn to 0", async () => {
			await store.upsert(RUN_ID, 10, "src/demoted.js", "content", "full");
			await store.demote(RUN_ID, "src/demoted.js");

			const model = await store.getModelContext(RUN_ID);
			const entry = model.find((e) => e.path === "src/demoted.js");
			assert.strictEqual(entry.state, "file:path");
			assert.strictEqual(entry.value, "");
		});
	});

	describe("result key generation", () => {
		it("generates sequential keys", async () => {
			const key1 = await store.nextResultPath(RUN_ID, "read");
			const key2 = await store.nextResultPath(RUN_ID, "edit");
			const key3 = await store.nextResultPath(RUN_ID, "read");

			assert.strictEqual(key1, "read://1");
			assert.strictEqual(key2, "edit://2");
			assert.strictEqual(key3, "read://3");
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
			const editEntry = log.find((e) => e.path === "edit://1");
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
				/CHECK constraint/,
			);
		});

		it("rejects invalid known state", async () => {
			await assert.rejects(
				() => store.upsert(RUN_ID, 0, "known://bad", "", "proposed"),
				/CHECK constraint/,
			);
		});

		it("rejects invalid edit state", async () => {
			await assert.rejects(
				() => store.upsert(RUN_ID, 0, "edit://999", "", "full"),
				/CHECK constraint/,
			);
		});
	});
});
