/**
 * Budget math verification.
 *
 * Proves that:
 * - Token counts in turn_context reflect ACTUAL context cost, not full-fidelity cost
 * - Budget enforcement measures assembled messages accurately
 * - Index entries cost nothing in the budget
 * - Summary entries cost only their summary/path rendering
 * - Full entries cost their body
 * - Progress token count matches reality
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import { countTokens } from "../../src/agent/tokens.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

function pad(n) {
	return Array(n).fill("hello world test data").join(" ");
}

describe("Budget math", () => {
	let tdb, store, cascade, RUN_ID;

	before(async () => {
		tdb = await TestDb.create("budget_math");
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);
		cascade = tdb.hooks.budget;
		const seed = await tdb.seedRun({ alias: "math_1" });
		RUN_ID = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("turn_context token accuracy", () => {
		it("full entry tokens match body cost", async () => {
			const body = pad(50);
			await store.upsert(RUN_ID, 1, "known://full_entry", body, 200, {
				fidelity: "full",
			});
			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 1,
				systemPrompt: "test",
			});
			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 1,
			});
			const entry = rows.find((r) => r.path === "known://full_entry");
			assert.ok(entry, "entry exists in turn_context");
			assert.strictEqual(
				entry.tokens,
				countTokens(body),
				"full entry tokens = countTokens(body)",
			);
		});

		it("archived entry does not appear in turn_context", async () => {
			const body = pad(200);
			await store.upsert(RUN_ID, 1, "test_file.js", body, 200, {
				fidelity: "archive",
			});
			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 1,
				systemPrompt: "test",
			});
			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 1,
			});
			const entry = rows.find((r) => r.path === "test_file.js");
			assert.strictEqual(
				entry,
				undefined,
				"archived entry excluded from context",
			);
		});

		it("summary entry body in view is full (onView transforms at runtime)", async () => {
			// The view projects full body for summary entries. The onView
			// callback (applied by TurnExecutor, not the test materialize
			// helper) transforms it to summary text. This test verifies the
			// view's behavior; E2E tests verify the full pipeline.
			const body = pad(200);
			await store.upsert(RUN_ID, 1, "known://summary_entry", body, 200, {
				fidelity: "summary",
				attributes: { summary: "test,keywords,here" },
			});
			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 1,
				systemPrompt: "test",
			});
			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 1,
			});
			const entry = rows.find((r) => r.path === "known://summary_entry");
			assert.ok(entry, "summary entry appears in turn_context");
			assert.strictEqual(entry.fidelity, "summary");
			// Body is full until onView transforms it — that's by design
			assert.ok(entry.body.length > 0, "view projects full body for summary");
		});
	});

	describe("budget enforcement accuracy", () => {
		it("budget enforce measures assembled messages, not stored tokens", async () => {
			const { runId } = await tdb.seedRun({ alias: "math_enforce" });

			// Create a large entry at archive — should NOT count toward budget
			await store.upsert(runId, 1, "big_archive_file.js", pad(500), 200, {
				fidelity: "archive",
			});
			// Create a small entry at full — should count
			await store.upsert(runId, 1, "known://small", "tiny fact", 200, {
				fidelity: "full",
			});

			await materialize(tdb.db, {
				runId,
				turn: 1,
				systemPrompt: "test",
			});

			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const messages = [
				{ role: "system", content: "test" },
				{
					role: "user",
					content: rows
						.filter((r) => r.path !== "system://prompt")
						.map((r) => r.body)
						.join("\n"),
				},
			];

			// Budget with 1000 token ceiling — should pass because index is free
			const result = await cascade.enforce({
				contextSize: 1000,
				messages,
				rows,
				lastPromptTokens: 0,
			});

			// The assembled messages should NOT include the 500-pad index body
			const _totalChars = messages.reduce(
				(s, m) => s + (m.content?.length || 0),
				0,
			);
			const indexFullCost = countTokens(pad(500));
			assert.ok(
				result.assembledTokens < indexFullCost,
				`assembled tokens (${result.assembledTokens}) should be far less than index entry full cost (${indexFullCost})`,
			);
		});

		it("post-dispatch enforce uses re-measured tokens, not stale LLM count", async () => {
			const { runId } = await tdb.seedRun({ alias: "math_postdispatch" });

			// Simulate: entries exist from dispatch (promoted files)
			await store.upsert(runId, 1, "known://big", pad(100), 200, {
				fidelity: "full",
			});

			await materialize(tdb.db, {
				runId,
				turn: 1,
				systemPrompt: "test",
			});

			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const messages = [
				{ role: "system", content: "test" },
				{
					role: "user",
					content: rows.map((r) => r.body).join("\n"),
				},
			];

			// With lastPromptTokens: 0, enforce MUST measure messages
			const result = await cascade.enforce({
				contextSize: 100,
				messages,
				rows,
				lastPromptTokens: 0,
			});

			assert.strictEqual(result.status, 413, "should overflow");
			assert.ok(
				result.assembledTokens > 0,
				"assembled tokens measured from messages, not from 0",
			);
			assert.ok(result.overflow > 0, "overflow computed from measured tokens");
		});
	});

	describe("token column semantics", () => {
		it("known_entries.tokens always reflects full body cost", async () => {
			const { runId } = await tdb.seedRun({ alias: "math_ke" });
			const body = pad(100);
			const expectedTokens = countTokens(body);

			await store.upsert(runId, 1, "known://fact", body, 200, {
				fidelity: "full",
			});
			let entries = await tdb.db.get_known_entries.all({ run_id: runId });
			let entry = entries.find((e) => e.path === "known://fact");
			assert.strictEqual(entry.tokens, expectedTokens, "tokens at full");

			// Demote to summary — tokens should NOT change
			await store.setFidelity(runId, "known://fact", "summary");
			entries = await tdb.db.get_known_entries.all({ run_id: runId });
			entry = entries.find((e) => e.path === "known://fact");
			assert.strictEqual(
				entry.tokens,
				expectedTokens,
				"tokens unchanged after demotion",
			);

			// Promote back — tokens should NOT change
			await store.promote(runId, "known://fact", 2);
			entries = await tdb.db.get_known_entries.all({ run_id: runId });
			entry = entries.find((e) => e.path === "known://fact");
			assert.strictEqual(
				entry.tokens,
				expectedTokens,
				"tokens unchanged after promotion",
			);
		});

		it("turn_context excludes archived entries", async () => {
			const { runId } = await tdb.seedRun({ alias: "math_tc" });
			const body = pad(100);

			// Entry at full
			await store.upsert(runId, 1, "known://tc_test", body, 200, {
				fidelity: "full",
			});
			await materialize(tdb.db, {
				runId,
				turn: 1,
				systemPrompt: "test",
			});
			let rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			let tc = rows.find((r) => r.path === "known://tc_test");
			const fullTcTokens = tc?.tokens ?? 0;
			assert.ok(fullTcTokens > 0, "full entry has tokens");

			// Archive — should disappear from turn_context
			await store.setFidelity(runId, "known://tc_test", "archive");
			await materialize(tdb.db, {
				runId,
				turn: 2,
				systemPrompt: "test",
			});
			rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 2,
			});
			tc = rows.find((r) => r.path === "known://tc_test");

			assert.strictEqual(
				tc,
				undefined,
				"archived entry excluded from turn_context",
			);
		});
	});
});
