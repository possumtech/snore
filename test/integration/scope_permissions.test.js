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
import Entries from "../../src/agent/Entries.js";
import { PermissionError } from "../../src/agent/errors.js";
import TestDb from "../helpers/TestDb.js";

describe("Scope + permissions (Phase D)", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create("scope_permissions");
		store = new Entries(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("permissive scheme accepts both model and plugin writers", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_ok" });

		await store.set({
			runId,
			turn: 1,
			path: "known://a",
			body: "fact a",
			state: "resolved",
			writer: "model",
		});
		await store.set({
			runId,
			turn: 1,
			path: "known://b",
			body: "fact b",
			state: "resolved",
			writer: "plugin",
		});

		const a = await store.getBody(runId, "known://a");
		const b = await store.getBody(runId, "known://b");
		assert.strictEqual(a, "fact a");
		assert.strictEqual(b, "fact b");
	});

	it("audit scheme rejects plugin writer with PermissionError", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_audit_plugin" });

		await assert.rejects(
			store.set({
				runId,
				turn: 1,
				path: "system://probe",
				body: "attempt",
				state: "resolved",
				writer: "plugin",
			}),
			(err) =>
				err instanceof PermissionError &&
				err.scheme === "system" &&
				err.writer === "plugin",
		);
	});

	it("audit scheme rejects model writer with PermissionError", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_audit_model" });

		await assert.rejects(
			store.set({
				runId,
				turn: 1,
				path: "reasoning://probe",
				body: "attempt",
				state: "resolved",
				writer: "model",
			}),
			(err) =>
				err instanceof PermissionError &&
				err.scheme === "reasoning" &&
				err.writer === "model",
		);
	});

	it("audit scheme accepts system writer", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_audit_ok" });

		await store.set({
			runId,
			turn: 1,
			path: "assistant://1",
			body: "response body",
			state: "resolved",
			writer: "system",
		});
		const body = await store.getBody(runId, "assistant://1");
		assert.strictEqual(body, "response body");
	});

	it("prompt scheme rejects model writer with PermissionError", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_prompt_model" });

		await assert.rejects(
			store.set({
				runId,
				turn: 1,
				path: "prompt://1",
				body: "forged prompt",
				state: "resolved",
				writer: "model",
			}),
			(err) =>
				err instanceof PermissionError &&
				err.scheme === "prompt" &&
				err.writer === "model",
		);
	});

	it("prompt scheme accepts plugin writer", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_prompt_ok" });

		await store.set({
			runId,
			turn: 1,
			path: "prompt://1",
			body: "user prompt",
			state: "resolved",
			writer: "plugin",
			attributes: { mode: "ask" },
		});
		const body = await store.getBody(runId, "prompt://1");
		assert.strictEqual(body, "user prompt");
	});

	it("entries land at 'run:<runId>' scope by default", async () => {
		const { runId } = await tdb.seedRun({ alias: "perm_scope" });

		await store.set({
			runId,
			turn: 1,
			path: "known://scoped",
			body: "content",
			state: "resolved",
			writer: "model",
		});

		const all = await tdb.db.get_known_entries.all({ run_id: runId });
		const match = all.find((e) => e.path === "known://scoped");
		assert.ok(match, "view row exists");
		assert.strictEqual(match.scope, `run:${runId}`);
	});
});
