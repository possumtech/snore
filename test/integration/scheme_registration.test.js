/**
 * Scheme registration integration test.
 *
 * Verifies that plugins register schemes correctly and the
 * v_model_context VIEW can resolve all scheme types.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("Scheme registration via plugins", () => {
	let tdb, store, runId;

	before(async () => {
		tdb = await TestDb.create();
		store = new Entries(tdb.db);
		const seed = await tdb.seedRun({ alias: "scheme_1" });
		runId = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("all tool plugins are registered", () => {
		const tools = [...tdb.hooks.tools.names];
		assert.ok(tools.length >= 9, `expected 9+ tools, got ${tools.length}`);
		for (const name of [
			"get",
			"set",
			"rm",
			"mv",
			"cp",
			"sh",
			"env",
			"known",
			"ask_user",
		]) {
			assert.ok(tools.includes(name), `tool "${name}" should be registered`);
		}
	});

	it("bare file paths visible in model context", async () => {
		await store.set({
			runId,
			turn: 0,
			path: "src/app.js",
			body: "const x = 1;",
			state: "resolved",
		});
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "src/app.js");
		assert.ok(entry, "bare path visible in model context");
		assert.strictEqual(entry.category, "data");
	});

	it("known:// entries visible in model context", async () => {
		await store.set({
			runId,
			turn: 1,
			path: "known://test_fact",
			body: "earth is round",
			state: "resolved",
		});
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "known://test_fact");
		assert.ok(entry, "known entry visible in model context");
		assert.strictEqual(entry.category, "data");
	});

	it("unknown:// entries visible in model context", async () => {
		await store.set({
			runId,
			turn: 1,
			path: "unknown://what_is_x",
			body: "what is x",
			state: "resolved",
		});
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "unknown://what_is_x");
		assert.ok(entry, "unknown entry visible in model context");
		assert.strictEqual(entry.category, "unknown");
	});

	it("audit entries hidden from model context", async () => {
		// Audit schemes are system-only in production; tests simulating
		// them use writer: "system" to match.
		await store.set({
			runId,
			turn: 1,
			path: "system://1",
			body: "system prompt",
			state: "resolved",
			writer: "system",
		});
		await store.set({
			runId,
			turn: 1,
			path: "assistant://1",
			body: "model response",
			state: "resolved",
			writer: "system",
		});
		await store.set({
			runId,
			turn: 1,
			path: "model://1",
			body: "{}",
			state: "resolved",
			writer: "system",
		});
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const audit = rows.filter((r) =>
			["system://1", "assistant://1", "model://1"].includes(r.path),
		);
		assert.strictEqual(audit.length, 0, "audit entries should be hidden");
	});

	it("proposed entries are visible in model context", async () => {
		await store.set({
			runId,
			turn: 1,
			path: "set://proposed_edit",
			body: "edit",
			state: "proposed",
		});
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "set://proposed_edit");
		assert.ok(entry, "proposed entry should be visible");
		assert.strictEqual(entry.state, "proposed");
	});

	it("stored fidelity entries hidden from model context", async () => {
		await store.set({
			runId,
			turn: 1,
			path: "known://stored_fact",
			body: "archive",
			state: "resolved",
			fidelity: "archived",
		});
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "known://stored_fact");
		assert.ok(!entry, "stored entry should be hidden");
	});

	it("prompt entries visible in model context", async () => {
		await store.set({
			runId,
			turn: 1,
			path: "prompt://1",
			body: "what is this?",
			state: "resolved",
			attributes: { mode: "ask" },
		});
		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const entry = rows.find((r) => r.path === "prompt://1");
		assert.ok(entry, "prompt entry visible in model context");
		assert.strictEqual(entry.category, "prompt");
	});
});
