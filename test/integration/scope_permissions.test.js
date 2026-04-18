/**
 * Schema V2 Phase D — scope + permissions end-to-end.
 *
 * Verifies:
 * - Default writable_by for plugin-declared schemes allows model + plugin.
 * - Audit schemes (writable_by: ["system"]) reject plugin writes with 403.
 * - Prompt scheme (writable_by: ["plugin"]) rejects model writes with 403.
 * - Write with writer matching the declared list succeeds and lands in
 *   the entries table at scope = 'run:${runId}'.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("Scope + permissions (Phase D)", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create("scope_permissions");
		store = new KnownStore(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("permissive scheme accepts both model and plugin writers", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_ok" });

		await store.upsert(runId, 1, "known://a", "fact a", 200, {
			writer: "model",
		});
		await store.upsert(runId, 1, "known://b", "fact b", 200, {
			writer: "plugin",
		});

		const a = await store.getBody(runId, "known://a");
		const b = await store.getBody(runId, "known://b");
		assert.strictEqual(a, "fact a");
		assert.strictEqual(b, "fact b");
	});

	it("audit scheme rejects plugin writer with 403", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_audit_plugin" });

		await assert.rejects(
			store.upsert(runId, 1, "system://probe", "attempt", 200, {
				writer: "plugin",
			}),
			/403.*writer "plugin" not permitted for scheme "system"/,
		);
	});

	it("audit scheme rejects model writer with 403", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_audit_model" });

		await assert.rejects(
			store.upsert(runId, 1, "reasoning://probe", "attempt", 200, {
				writer: "model",
			}),
			/403.*writer "model" not permitted for scheme "reasoning"/,
		);
	});

	it("audit scheme accepts system writer", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_audit_ok" });

		await store.upsert(runId, 1, "assistant://1", "response body", 200, {
			writer: "system",
		});
		const body = await store.getBody(runId, "assistant://1");
		assert.strictEqual(body, "response body");
	});

	it("prompt scheme rejects model writer with 403", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_prompt_model" });

		await assert.rejects(
			store.upsert(runId, 1, "prompt://1", "forged prompt", 200, {
				writer: "model",
			}),
			/403.*writer "model" not permitted for scheme "prompt"/,
		);
	});

	it("prompt scheme accepts plugin writer", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_prompt_ok" });

		await store.upsert(runId, 1, "prompt://1", "user prompt", 200, {
			writer: "plugin",
			attributes: { mode: "ask" },
		});
		const body = await store.getBody(runId, "prompt://1");
		assert.strictEqual(body, "user prompt");
	});

	it("entries land at 'run:<runId>' scope by default", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_scope" });

		await store.upsert(runId, 1, "known://scoped", "content", 200, {
			writer: "model",
		});

		const all = await tdb.db.get_known_entries.all({ run_id: runId });
		const match = all.find((e) => e.path === "known://scoped");
		assert.ok(match, "view row exists");
		assert.strictEqual(match.scope, `run:${runId}`);
	});
});
