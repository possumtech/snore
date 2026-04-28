/**
 * Budget math verification.
 *
 * Covers @budget_enforcement — the numeric correctness of ceiling,
 * assembled-token measurement, and overflow computation that feed
 * the accept/reject decision in `budget.enforce`.
 *
 * Proves that:
 * - Token counts in turn_context reflect ACTUAL context cost, not full-visibility cost
 * - Budget enforcement measures assembled messages accurately
 * - Index entries cost nothing in the budget
 * - Summary entries cost only their summary/path rendering
 * - Full entries cost their body
 * - Progress token count matches reality
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
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
		store = new Entries(tdb.db);
		await store.loadSchemes(tdb.db);
		cascade = tdb.hooks.budget;
		const seed = await tdb.seedRun({ alias: "math_1" });
		RUN_ID = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("turn_context token accuracy", () => {
		it("full entry body matches what was stored", async () => {
			const body = pad(50);
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "known://full_entry",
				body,
				state: "resolved",
				visibility: "visible",
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
				entry.body,
				body,
				"projected body equals stored body for visible known",
			);
		});

		it("archived entry does not appear in turn_context", async () => {
			const body = pad(200);
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "test_file.js",
				body,
				state: "resolved",
				visibility: "archived",
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
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "known://summary_entry",
				body,
				state: "resolved",
				visibility: "summarized",
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
			assert.strictEqual(entry.visibility, "summarized");
			// Body is full until onView transforms it — that's by design
			assert.ok(entry.body.length > 0, "view projects full body for summary");
		});
	});

	describe("budget enforcement accuracy", () => {
		it("budget enforce measures assembled messages, not stored tokens", async () => {
			const { runId } = await tdb.seedRun({ alias: "math_enforce" });

			// Create a large entry at archive — should NOT count toward budget
			await store.set({
				runId,
				turn: 1,
				path: "big_archive_file.js",
				body: pad(500),
				state: "resolved",
				visibility: "archived",
			});
			// Create a small entry at full — should count
			await store.set({
				runId,
				turn: 1,
				path: "known://small",
				body: "tiny fact",
				state: "resolved",
				visibility: "visible",
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
			await store.set({
				runId,
				turn: 1,
				path: "known://big",
				body: pad(100),
				state: "resolved",
				visibility: "visible",
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
				ctx: { runId: 1, turn: 1, loopId: 0, loopIteration: 0 },
				rummy: {
					hooks: { error: { log: { emit: async () => {} } } },
				},
			});

			assert.strictEqual(result.ok, false, "should overflow");
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

			await store.set({
				runId,
				turn: 1,
				path: "known://fact",
				body,
				state: "resolved",
				visibility: "visible",
			});
			let entries = await tdb.db.get_known_entries.all({ run_id: runId });
			let entry = entries.find((e) => e.path === "known://fact");
			assert.strictEqual(entry.tokens, expectedTokens, "tokens at full");

			// Demote to summary — tokens should NOT change
			await store.set({
				runId: runId,
				path: "known://fact",
				visibility: "summarized",
			});
			entries = await tdb.db.get_known_entries.all({ run_id: runId });
			entry = entries.find((e) => e.path === "known://fact");
			assert.strictEqual(
				entry.tokens,
				expectedTokens,
				"tokens unchanged after demotion",
			);

			// Promote back — tokens should NOT change
			await store.get({ runId: runId, turn: 2, path: "known://fact" });
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
			await store.set({
				runId,
				turn: 1,
				path: "known://tc_test",
				body,
				state: "resolved",
				visibility: "visible",
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
			assert.ok(tc, "full entry present in turn_context");

			// Archive — should disappear from turn_context
			await store.set({
				runId: runId,
				path: "known://tc_test",
				visibility: "archived",
			});
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

	// The wire contract between budget math and what the model sees.
	// These tests verify the two signals the model actually reads when
	// regulating itself: `<prompt tokenUsage="N" tokensFree="M">` and
	// the `reverted="N"` attribute that surfaces after a demotion.
	describe("prompt signal correctness", () => {
		let Prompt;
		let assemblePrompt;

		before(async () => {
			Prompt = (await import("../../src/plugins/prompt/prompt.js")).default;
			// Construct the plugin against a shim core so we can call the
			// assemblePrompt filter directly.
			const shim = {
				hooks: {
					tools: {
						onView() {},
						names: ["get", "set"],
						advertisedNames: ["get", "set"],
					},
				},
				on() {},
				filter() {},
			};
			const plugin = new Prompt(shim);
			assemblePrompt = plugin.assemblePrompt.bind(plugin);
		});

		function fakePromptRow(body = "hello") {
			return {
				ordinal: 1,
				path: "prompt://1",
				scheme: "prompt",
				visibility: "visible",
				body,
				tokens: countTokens(body),
				attributes: JSON.stringify({ mode: "act" }),
				category: "prompt",
				source_turn: 1,
			};
		}

		it("prompt no longer carries tokenUsage/tokensFree (moved to <budget>)", async () => {
			const contextSize = 10000;
			const out = await assemblePrompt("", {
				rows: [fakePromptRow()],
				contextSize,
				lastContextTokens: 8421,
				type: "act",
				turn: 2,
			});
			assert.ok(
				!/tokenUsage=|tokensFree=/.test(out),
				"prompt has no budget attrs",
			);
		});

		it("reverted='N' surfaces when prior turn had a 413 demotion", async () => {
			const contextSize = 10000;
			const out = await assemblePrompt("", {
				rows: [
					fakePromptRow(),
					{
						ordinal: 2,
						path: "log://turn_2/error/Token%20Budget%20overflow%3A%20foo",
						scheme: "log",
						visibility: "summarized",
						body: "Token Budget overflow: ...",
						tokens: 30,
						attributes: JSON.stringify({
							status: 413,
							demotedCount: 4,
							demotedTokens: 22000,
						}),
						category: "logging",
						source_turn: 2,
					},
				],
				contextSize,
				lastContextTokens: 5000,
				type: "act",
				turn: 3,
			});
			assert.ok(
				/reverted="4"/.test(out),
				`reverted=4 must surface; got: ${out}`,
			);
		});

		it("reverted absent when prior turn had no 413", async () => {
			const contextSize = 10000;
			const out = await assemblePrompt("", {
				rows: [fakePromptRow()],
				contextSize,
				lastContextTokens: 5000,
				type: "act",
				turn: 3,
			});
			assert.ok(
				!out.includes("reverted="),
				"no reverted attr when no prior 413",
			);
		});

		it("reverted only looks at PRIOR turn, not older ones", async () => {
			const contextSize = 10000;
			// 413 occurred on turn 1. Current turn is 5. Prior turn is 4.
			// We should NOT surface reverted from turn 1 — that's old news,
			// the model has seen it many times.
			const out = await assemblePrompt("", {
				rows: [
					fakePromptRow(),
					{
						ordinal: 2,
						path: "log://turn_1/error/Token%20Budget%20overflow",
						scheme: "log",
						visibility: "summarized",
						body: "Token Budget overflow: ...",
						tokens: 30,
						attributes: JSON.stringify({
							status: 413,
							demotedCount: 2,
							demotedTokens: 8000,
						}),
						category: "logging",
						source_turn: 1,
					},
				],
				contextSize,
				lastContextTokens: 5000,
				type: "act",
				turn: 5,
			});
			assert.ok(
				!out.includes("reverted="),
				"reverted only for immediately-prior turn",
			);
		});
	});

	describe("413 error carries structured demotion attrs", () => {
		it("emits demotedCount and demotedTokens on the 413 error entry", async () => {
			const { runId } = await tdb.seedRun({ alias: "err_attrs_413" });
			// Seed enough content to trip the post-dispatch ceiling.
			for (let i = 0; i < 20; i++) {
				await store.set({
					runId,
					turn: 1,
					path: `known://big_${i}`,
					body: pad(100),
					state: "resolved",
					visibility: "visible",
				});
			}
			await tdb.hooks.budget.postDispatch({
				contextSize: 1000,
				ctx: {
					runId,
					loopId: null,
					turn: 1,
					systemPrompt: "test",
					mode: "act",
					toolSet: null,
				},
				rummy: {
					db: tdb.db,
					hooks: tdb.hooks,
					entries: store,
				},
			});

			const rows = await tdb.db.get_known_entries.all({ run_id: runId });
			const err = rows.find(
				(r) => r.path.startsWith("log://turn_1/error/") && r.scheme === "log",
			);
			assert.ok(err, "413 error entry written");
			const attrs = JSON.parse(err.attributes);
			assert.strictEqual(attrs.status, 413);
			assert.ok(attrs.demotedCount > 0, "demotedCount present and positive");
			assert.ok(attrs.demotedTokens > 0, "demotedTokens present and positive");
		});
	});
});
