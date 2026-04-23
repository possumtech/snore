/**
 * Entry lifecycle from creation through materialization.
 *
 * Covers @entries (create/read/remove + scheme derivation) and
 * @upsert_semantics (visibility determines v_model_context inclusion).
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("entry lifecycle (@entries, @upsert_semantics, @plugins_entry_lifecycle)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("entry_lifecycle");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("created entries carry scheme, path, body, state", async () => {
		const { runId } = await tdb.seedRun({ alias: "entry_basic" });
		const store = new Entries(tdb.db);
		await store.set({
			runId,
			turn: 1,
			path: "known://test",
			body: "test body",
			state: "resolved",
		});
		const entries = await tdb.db.get_known_entries.all({ run_id: runId });
		const entry = entries.find((e) => e.path === "known://test");
		assert.ok(entry, "entry created");
		assert.strictEqual(entry.scheme, "known", "scheme derived from path");
		assert.strictEqual(entry.body, "test body");
		assert.strictEqual(entry.state, "resolved");
	});

	it("summarized default makes data entries visible as summaries in v_model_context", async () => {
		const { runId } = await tdb.seedRun({ alias: "entry_vis_default" });
		const store = new Entries(tdb.db);
		await store.set({
			runId,
			turn: 1,
			path: "known://lifecycle_vis",
			body: "visible",
			state: "resolved",
		});

		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const row = rows.find((r) => r.path === "known://lifecycle_vis");
		assert.ok(row, "entry appears in v_model_context");
		// Data-category default is `summarized` — summary indexes in,
		// body on-demand via <get>. Writers that need `visible`
		// pass visibility explicitly.
		assert.strictEqual(row.visibility, "summarized");
	});

	it("archived visibility hides an entry from v_model_context", async () => {
		const { runId } = await tdb.seedRun({ alias: "entry_vis_archived" });
		const store = new Entries(tdb.db);
		await store.set({
			runId,
			turn: 1,
			path: "known://lifecycle_archived",
			body: "hidden",
			state: "resolved",
			visibility: "archived",
		});

		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const row = rows.find((r) => r.path === "known://lifecycle_archived");
		assert.ok(!row, "archived entry is not in v_model_context");
	});
});
