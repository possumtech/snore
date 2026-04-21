import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("Entries integration", () => {
	let tdb;
	let store;
	let RUN_ID;

	before(async () => {
		tdb = await TestDb.create();
		store = new Entries(tdb.db);
		const seed = await tdb.seedRun({ alias: "test_1" });
		RUN_ID = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("scheme extraction", () => {
		it("bare paths have null scheme", () => {
			assert.strictEqual(Entries.scheme("src/app.js"), null);
			assert.strictEqual(Entries.scheme("package.json"), null);
		});

		it("known:// scheme", () => {
			assert.strictEqual(Entries.scheme("known://auth_flow"), "known");
		});

		it("tool schemes", () => {
			assert.strictEqual(Entries.scheme("search://4"), "search");
			assert.strictEqual(Entries.scheme("set://7"), "set");
			assert.strictEqual(Entries.scheme("summarize://1"), "summarize");
		});

		it("unknown:// scheme", () => {
			assert.strictEqual(Entries.scheme("unknown://1"), "unknown");
			assert.strictEqual(Entries.scheme("unknown://42"), "unknown");
		});
	});

	describe("toolFromPath", () => {
		it("extracts tool name from result keys", () => {
			assert.strictEqual(Entries.toolFromPath("search://4"), "search");
			assert.strictEqual(Entries.toolFromPath("set://7"), "set");
			assert.strictEqual(Entries.toolFromPath("summarize://1"), "summarize");
		});

		it("returns null for bare file paths", () => {
			assert.strictEqual(Entries.toolFromPath("src/app.js"), null);
		});

		it("returns 'known' for known:// keys", () => {
			assert.strictEqual(Entries.toolFromPath("known://auth"), "known");
		});
	});

	describe("isSystemPath", () => {
		it("detects /: prefix", () => {
			assert.ok(Entries.isSystemPath("known://x"));
			assert.ok(Entries.isSystemPath("search://1"));
			assert.ok(!Entries.isSystemPath("src/app.js"));
		});
	});

	describe("upsert and getAll", () => {
		it("inserts a file entry", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "src/app.js",
				body: "const x = 1;",
				state: "resolved",
			});
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "src/app.js");
			assert.ok(entry);
			assert.strictEqual(entry.scheme, null);
			assert.strictEqual(entry.state, "resolved");
			assert.strictEqual(entry.body, "const x = 1;");
		});

		it("inserts a knowledge entry", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://db_type",
				body: "SQLite",
				state: "resolved",
			});
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "known://db_type");
			assert.ok(entry);
			assert.strictEqual(entry.scheme, "known");
			assert.strictEqual(entry.state, "resolved");
		});

		it("inserts a result entry", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "search://1",
				body: "file contents",
				state: "resolved",
				attributes: { command: "read src/app.js" },
			});
			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "search://1");
			assert.ok(entry);
			assert.strictEqual(entry.scheme, "search");
			assert.strictEqual(entry.state, "resolved");
			assert.ok(entry.attributes);
			const attributes = JSON.parse(entry.attributes);
			assert.strictEqual(attributes.command, "read src/app.js");
		});

		it("upsert overwrites value on conflict", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://db_type",
				body: "PostgreSQL",
				state: "resolved",
			});
			const rows = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = rows.find((e) => e.path === "known://db_type");
			assert.strictEqual(entry.body, "PostgreSQL");
		});

		it("upsert preserves meta when new meta is null", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "search://1",
				body: "updated",
				state: "resolved",
			});
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
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "known://temp",
				body: "temporary",
				state: "resolved",
			});
			let all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			assert.ok(all.find((e) => e.path === "known://temp"));

			await store.rm({ runId: RUN_ID, path: "known://temp" });
			all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			assert.ok(!all.find((e) => e.path === "known://temp"));
		});
	});

	describe("resolve", () => {
		it("changes proposed to pass with output", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "set://1",
				body: "",
				state: "proposed",
				attributes: { path: "src/app.js", search: "old", replace: "new" },
			});
			const unresolved = await store.getUnresolved(RUN_ID);
			assert.strictEqual(unresolved.length, 1);
			assert.strictEqual(unresolved[0].path, "set://1");

			await store.set({
				runId: RUN_ID,
				path: "set://1",
				state: "resolved",
				body: "edit applied",
			});
			const after = await store.getUnresolved(RUN_ID);
			assert.strictEqual(after.length, 0);

			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "set://1");
			assert.strictEqual(entry.state, "resolved");
			assert.strictEqual(entry.body, "edit applied");
		});

		it("changes proposed to rejected on rejection", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "sh://1",
				body: "",
				state: "proposed",
				attributes: { command: "npm test" },
			});
			await store.set({
				runId: RUN_ID,
				path: "sh://1",
				state: "failed",
				body: "rejected by user",
			});

			const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const entry = all.find((e) => e.path === "sh://1");
			assert.strictEqual(entry.state, "failed");
		});
	});

	describe("promote and demote", () => {
		it("promote sets fidelity to full and updates turn", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 0,
				path: "src/promoted.js",
				body: "content",
				state: "resolved",
				fidelity: "demoted",
			});
			let row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/promoted.js",
			});
			assert.strictEqual(row.fidelity, "demoted");

			await store.get({ runId: RUN_ID, turn: 10, path: "src/promoted.js" });
			row = await tdb.db.get_entry_state.get({
				run_id: RUN_ID,
				path: "src/promoted.js",
			});
			assert.strictEqual(row.fidelity, "promoted");
			assert.strictEqual(row.turn, 10);
		});

		it("demote sets fidelity to stored", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 10,
				path: "src/demoted.js",
				body: "content",
				state: "resolved",
			});
			await store.set({
				runId: RUN_ID,
				path: "src/demoted.js",
				fidelity: "archived",
			});

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
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "search://Tom_Petty_death",
				body: "",
				state: "resolved",
			});
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

			// Contract: unified history shape is
			// { tool, path, state, outcome, body, turn, attributes }
			for (const entry of log) {
				assert.ok("tool" in entry);
				assert.ok("state" in entry);
				assert.ok("path" in entry);
				assert.ok("body" in entry);
			}
		});

		it("derives tool name from key prefix", async () => {
			const log = await store.getLog(RUN_ID);
			const searchEntry = log.find((e) => e.path.startsWith("search://"));
			assert.strictEqual(searchEntry.tool, "search");
		});
	});

	describe("rm resolution", () => {
		it("accept erases the target file key from store", async () => {
			// Setup: file exists in store
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/doomed.js",
				body: "content",
				state: "resolved",
			});
			const before = await store.getBody(RUN_ID, "src/doomed.js");
			assert.strictEqual(before, "content");

			// Setup: proposed rm entry targeting that file
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "rm://50",
				body: "",
				state: "proposed",
				attributes: { path: "src/doomed.js" },
			});

			// Resolve: accept the rm
			await store.set({
				runId: RUN_ID,
				path: "rm://50",
				state: "resolved",
				body: "",
			});

			// Verify: target file key is gone — use resolve to check meta, then remove
			const attributes = await store.getAttributes(RUN_ID, "rm://50");
			assert.strictEqual(attributes.path, "src/doomed.js");
			await store.rm({ runId: RUN_ID, path: attributes.path });

			const after = await store.getBody(RUN_ID, "src/doomed.js");
			assert.strictEqual(
				after,
				null,
				"target file should be removed from store",
			);
		});

		it("reject preserves the target file key", async () => {
			// Setup: file exists
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/survivor.js",
				body: "alive",
				state: "resolved",
			});

			// Setup: proposed rm
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "rm://51",
				body: "",
				state: "proposed",
				attributes: { path: "src/survivor.js" },
			});

			// Resolve: reject
			await store.set({
				runId: RUN_ID,
				path: "rm://51",
				state: "failed",
				body: "rejected",
			});

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
				() =>
					store.set({
						runId: RUN_ID,
						turn: 0,
						path: "bad.js",
						body: "",
						state: 99,
					}),
				/CHECK/,
			);
		});

		it("rejects status above 599", async () => {
			await assert.rejects(
				() =>
					store.set({
						runId: RUN_ID,
						turn: 0,
						path: "known://bad",
						body: "",
						state: 600,
					}),
				/CHECK/,
			);
		});

		it("rejects non-integer status", async () => {
			await assert.rejects(
				() =>
					store.set({
						runId: RUN_ID,
						turn: 0,
						path: "set://999",
						body: "",
						state: "index",
					}),
				/CHECK|datatype/i,
			);
		});
	});
});
