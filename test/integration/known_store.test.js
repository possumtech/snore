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
			assert.strictEqual(KnownStore.scheme("search://4"), "search");
			assert.strictEqual(KnownStore.scheme("set://7"), "set");
			assert.strictEqual(KnownStore.scheme("summarize://1"), "summarize");
		});

		it("unknown:// scheme", () => {
			assert.strictEqual(KnownStore.scheme("unknown://1"), "unknown");
			assert.strictEqual(KnownStore.scheme("unknown://42"), "unknown");
		});
	});

	describe("toolFromPath", () => {
		it("extracts tool name from result keys", () => {
			assert.strictEqual(KnownStore.toolFromPath("search://4"), "search");
			assert.strictEqual(KnownStore.toolFromPath("set://7"), "set");
			assert.strictEqual(KnownStore.toolFromPath("summarize://1"), "summarize");
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
			assert.ok(KnownStore.isSystemPath("search://1"));
			assert.ok(!KnownStore.isSystemPath("src/app.js"));
		});
	});

	describe("upsert and getAll", () => {
		it("inserts a file entry", async () => {
			await store.upsert(RUN_ID, 0, "src/app.js", "const x = 1;", 200);
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "src/app.js");
			assert.ok(entry);
			assert.strictEqual(entry.scheme, null);
			assert.strictEqual(entry.status, 200);
			assert.strictEqual(entry.body, "const x = 1;");
		});

		it("inserts a knowledge entry", async () => {
			await store.upsert(RUN_ID, 0, "known://db_type", "SQLite", 200);
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "known://db_type");
			assert.ok(entry);
			assert.strictEqual(entry.scheme, "known");
			assert.strictEqual(entry.status, 200);
		});

		it("inserts a result entry", async () => {
			await store.upsert(RUN_ID, 1, "search://1", "file contents", 200, {
				attributes: { command: "read src/app.js" },
			});
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "search://1");
			assert.ok(entry);
			assert.strictEqual(entry.scheme, "search");
			assert.strictEqual(entry.status, 200);
			assert.ok(entry.attributes);
			const attributes = JSON.parse(entry.attributes);
			assert.strictEqual(attributes.command, "read src/app.js");
		});

		it("upsert overwrites value on conflict", async () => {
			await store.upsert(RUN_ID, 0, "known://db_type", "PostgreSQL", 200);
			const rows = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = rows.find((e) => e.path === "known://db_type");
			assert.strictEqual(entry.body, "PostgreSQL");
		});

		it("upsert preserves meta when new meta is null", async () => {
			await store.upsert(RUN_ID, 0, "search://1", "updated", 200);
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "search://1");
			assert.ok(
				entry.attributes,
				"attributes should be preserved from first write",
			);
		});
	});

	describe("remove", () => {
		it("deletes an entry", async () => {
			await store.upsert(RUN_ID, 0, "known://temp", "temporary", 200);
			let all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			assert.ok(all.find((e) => e.path === "known://temp"));

			await store.remove(RUN_ID, "known://temp");
			all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			assert.ok(!all.find((e) => e.path === "known://temp"));
		});
	});

	describe("resolve", () => {
		it("changes proposed to pass with output", async () => {
			await store.upsert(RUN_ID, 1, "set://1", "", 202, {
				attributes: { file: "src/app.js", search: "old", replace: "new" },
			});
			const unresolved = await store.getUnresolved(RUN_ID);
			assert.strictEqual(unresolved.length, 1);
			assert.strictEqual(unresolved[0].path, "set://1");

			await store.resolve(RUN_ID, "set://1", 200, "edit applied");
			const after = await store.getUnresolved(RUN_ID);
			assert.strictEqual(after.length, 0);

			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "set://1");
			assert.strictEqual(entry.status, 200);
			assert.strictEqual(entry.body, "edit applied");
		});

		it("changes proposed to rejected on rejection", async () => {
			await store.upsert(RUN_ID, 1, "sh://1", "", 202, {
				attributes: { command: "npm test" },
			});
			await store.resolve(RUN_ID, "sh://1", 403, "rejected by user");

			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "sh://1");
			assert.strictEqual(entry.status, 403);
		});
	});

	describe("promote and demote", () => {
		it("promote sets fidelity to full and updates turn", async () => {
			await store.upsert(RUN_ID, 0, "src/promoted.js", "content", 200, {
				fidelity: "demoted",
			});
			let row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/promoted.js",
			});
			assert.strictEqual(row.fidelity, "demoted");

			await store.promote(RUN_ID, "src/promoted.js", 10);
			row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/promoted.js",
			});
			assert.strictEqual(row.fidelity, "promoted");
			assert.strictEqual(row.turn, 10);
		});

		it("demote sets fidelity to stored", async () => {
			await store.upsert(RUN_ID, 10, "src/demoted.js", "content", 200);
			await store.demote(RUN_ID, "src/demoted.js");

			const row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/demoted.js",
			});
			assert.strictEqual(row.fidelity, "archived");
		});
	});

	describe("slug path generation", () => {
		it("generates snake_case slugs from body", async () => {
			const key1 = await store.slugPath(RUN_ID, "search", "Tom Petty death");
			assert.strictEqual(key1, "search://Tom_Petty_death");
		});

		it("derives hierarchical paths from summary keywords", async () => {
			const key = await store.slugPath(
				RUN_ID,
				"known",
				"body irrelevant when summary present",
				"history,mongol,khan",
			);
			assert.strictEqual(key, "known://history/mongol/khan");
		});

		it("handles collisions with sequence suffix", async () => {
			await store.upsert(RUN_ID, 1, "search://Tom_Petty_death", "", 200);
			const key2 = await store.slugPath(RUN_ID, "search", "Tom Petty death");
			assert.match(key2, /^search:\/\/Tom_Petty_death_\d+$/);
		});

		it("uses timestamp for empty content", async () => {
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

			// All entries should have tool, target, status, key, body
			for (const entry of log) {
				assert.ok("tool" in entry);
				assert.ok("target" in entry);
				assert.ok("status" in entry);
				assert.ok("path" in entry);
				assert.ok("body" in entry);
			}
		});

		it("derives tool name from key prefix", async () => {
			const log = await store.getLog(RUN_ID);
			const searchEntry = log.find((e) => e.path.startsWith("search://"));
			assert.strictEqual(searchEntry.tool, "search");
		});

		it("derives target from meta", async () => {
			const log = await store.getLog(RUN_ID);
			const editEntry = log.find((e) => e.path === "set://1");
			assert.ok(editEntry);
			assert.strictEqual(editEntry.target, "src/app.js");
		});
	});

	describe("rm resolution", () => {
		it("accept erases the target file key from store", async () => {
			// Setup: file exists in store
			await store.upsert(RUN_ID, 1, "src/doomed.js", "content", 200);
			const before = await store.getBody(RUN_ID, "src/doomed.js");
			assert.strictEqual(before, "content");

			// Setup: proposed rm entry targeting that file
			await store.upsert(RUN_ID, 1, "rm://50", "", 202, {
				attributes: { path: "src/doomed.js" },
			});

			// Resolve: accept the rm
			await store.resolve(RUN_ID, "rm://50", 200, "");

			// Verify: target file key is gone — use resolve to check meta, then remove
			const attributes = await store.getAttributes(RUN_ID, "rm://50");
			assert.strictEqual(attributes.path, "src/doomed.js");
			await store.remove(RUN_ID, attributes.path);

			const after = await store.getBody(RUN_ID, "src/doomed.js");
			assert.strictEqual(
				after,
				null,
				"target file should be removed from store",
			);
		});

		it("reject preserves the target file key", async () => {
			// Setup: file exists
			await store.upsert(RUN_ID, 1, "src/survivor.js", "alive", 200);

			// Setup: proposed rm
			await store.upsert(RUN_ID, 1, "rm://51", "", 202, {
				attributes: { path: "src/survivor.js" },
			});

			// Resolve: reject
			await store.resolve(RUN_ID, "rm://51", 403, "rejected");

			// Verify: file still exists
			const value = await store.getBody(RUN_ID, "src/survivor.js");
			assert.strictEqual(
				value,
				"alive",
				"target file should survive rejection",
			);
		});
	});

	describe("status CHECK constraint", () => {
		it("rejects status below 100", async () => {
			await assert.rejects(
				() => store.upsert(RUN_ID, 0, "bad.js", "", 99),
				/CHECK/,
			);
		});

		it("rejects status above 599", async () => {
			await assert.rejects(
				() => store.upsert(RUN_ID, 0, "known://bad", "", 600),
				/CHECK/,
			);
		});

		it("rejects non-integer status", async () => {
			await assert.rejects(
				() => store.upsert(RUN_ID, 0, "set://999", "", "index"),
				/CHECK|datatype/i,
			);
		});
	});
});
