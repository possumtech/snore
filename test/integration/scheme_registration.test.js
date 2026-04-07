/**
 * Scheme registration integration test.
 *
 * Verifies that plugins register schemes correctly and the
 * v_model_context VIEW can resolve all scheme types.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("Scheme registration via plugins", () => {
	let tdb, store, runId;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun({ alias: "scheme_1" });
		runId = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("all tool plugins are registered", () => {
		const tools = [...tdb.hooks.tools.names];
		assert.ok(tools.length >= 10, `expected 10+ tools, got ${tools.length}`);
		for (const name of [
			"get",
			"set",
			"rm",
			"mv",
			"cp",
			"sh",
			"env",
			"store",
			"known",
			"ask_user",
		]) {
			assert.ok(tools.includes(name), `tool "${name}" should be registered`);
		}
	});

	it("bare file paths visible in model context", async () => {
		await store.upsert(runId, 0, "src/app.js", "const x = 1;", 200);
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "src/app.js");
		assert.ok(entry, "bare path visible in model context");
		assert.strictEqual(entry.category, "file");
	});

	it("known:// entries visible in model context", async () => {
		await store.upsert(runId, 1, "known://test_fact", "earth is round", 200);
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "known://test_fact");
		assert.ok(entry, "known entry visible in model context");
		assert.strictEqual(entry.category, "known");
	});

	it("unknown:// entries visible in model context", async () => {
		await store.upsert(runId, 1, "unknown://what_is_x", "what is x", 200);
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "unknown://what_is_x");
		assert.ok(entry, "unknown entry visible in model context");
		assert.strictEqual(entry.category, "unknown");
	});

	it("audit entries hidden from model context", async () => {
		await store.upsert(runId, 1, "system://1", "system prompt", 200);
		await store.upsert(runId, 1, "assistant://1", "model response", 200);
		await store.upsert(runId, 1, "model://1", "{}", 200);
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const audit = rows.filter((r) =>
			["system://1", "assistant://1", "model://1"].includes(r.path),
		);
		assert.strictEqual(audit.length, 0, "audit entries should be hidden");
	});

	it("202 proposed entries hidden from model context", async () => {
		await store.upsert(runId, 1, "set://proposed_edit", "edit", 202);
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "set://proposed_edit");
		assert.ok(!entry, "proposed entry should be hidden");
	});

	it("stored fidelity entries hidden from model context", async () => {
		await store.upsert(runId, 1, "known://stored_fact", "stored", 200, {
			fidelity: "stored",
		});
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "known://stored_fact");
		assert.ok(!entry, "stored entry should be hidden");
	});

	it("prompt entries visible in model context", async () => {
		await store.upsert(runId, 1, "ask://1", "what is this?", 200);
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "ask://1");
		assert.ok(entry, "ask prompt visible in model context");
		assert.strictEqual(entry.category, "prompt");
	});
});
