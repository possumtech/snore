/**
 * Token accounting refactor — materialization is the sole authority on
 * what an entry costs. Per-entry materialization records carry vTokens
 * (cost when visible), sTokens (cost when summarized), and aTokens
 * (vTokens − sTokens, the promotion premium that the model sees on
 * per-entry tag attributes). Nothing else in the system has its own
 * opinion of "what an entry costs."
 *
 * Covers @token_accounting.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import materializeContext from "../../src/agent/materializeContext.js";
import { countTokens } from "../../src/agent/tokens.js";
import TestDb from "../helpers/TestDb.js";

describe("token accounting (@token_accounting)", () => {
	let tdb, store, runId, loopId;

	before(async () => {
		tdb = await TestDb.create("token_accounting");
		store = new Entries(tdb.db);
		await store.loadSchemes(tdb.db);
		const seed = await tdb.seedRun({ alias: "tok" });
		runId = seed.runId;
		loopId = null;
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("per-entry vTokens / sTokens / aTokens", () => {
		it("known entry materializes with vTokens, sTokens, and aTokens fields", async () => {
			const body = "Paris is the capital of France.\n".repeat(20);
			await store.set({
				runId,
				turn: 1,
				path: "known://france/capital",
				body,
				state: "resolved",
				visibility: "visible",
				attributes: { summary: "france,capital,paris" },
			});

			const result = await materializeContext({
				db: tdb.db,
				hooks: tdb.hooks,
				entries: store,
				runId,
				loopId,
				turn: 1,
				systemPrompt: "test",
				mode: "ask",
				toolSet: null,
				contextSize: 50000,
			});
			const known = result.rows.find(
				(r) => r.path === "known://france/capital",
			);
			assert.ok(known, "known entry present in materialized rows");
			assert.ok(
				typeof known.vTokens === "number",
				`vTokens populated as number; got ${known.vTokens}`,
			);
			assert.ok(
				typeof known.sTokens === "number",
				`sTokens populated as number; got ${known.sTokens}`,
			);
			assert.ok(
				typeof known.aTokens === "number",
				`aTokens populated as number; got ${known.aTokens}`,
			);
		});

		it("aTokens = vTokens − sTokens by construction", async () => {
			const result = await materializeContext({
				db: tdb.db,
				hooks: tdb.hooks,
				entries: store,
				runId,
				loopId,
				turn: 1,
				systemPrompt: "test",
				mode: "ask",
				toolSet: null,
				contextSize: 50000,
			});
			for (const row of result.rows) {
				if (row.aTokens == null) continue;
				assert.strictEqual(
					row.aTokens,
					row.vTokens - row.sTokens,
					`aTokens=${row.aTokens} ≠ vTokens(${row.vTokens}) − sTokens(${row.sTokens}) for ${row.path}`,
				);
			}
		});

		it("vTokens reflects the visible projection regardless of current visibility", async () => {
			// Plant the entry summarized; vTokens should still report what it
			// would cost if visible (the lever the model is reasoning about).
			const body = "x".repeat(800);
			await store.set({
				runId,
				turn: 2,
				path: "known://summarized_now",
				body,
				state: "resolved",
				visibility: "summarized",
				attributes: { summary: "lever-test" },
			});

			const result = await materializeContext({
				db: tdb.db,
				hooks: tdb.hooks,
				entries: store,
				runId,
				loopId,
				turn: 2,
				systemPrompt: "test",
				mode: "ask",
				toolSet: null,
				contextSize: 50000,
			});
			const row = result.rows.find((r) => r.path === "known://summarized_now");
			assert.ok(row, "summarized entry materialized");
			// Render manually for comparison: the visible projection of a known
			// is its full body.
			const expectedVTokens = countTokens(body);
			assert.strictEqual(
				row.vTokens,
				expectedVTokens,
				"vTokens = countTokens(visible projection of body)",
			);
			// sTokens: known summarized projection is first 450 chars (per
			// known.js summary handler — fits under materializeContext's
			// 500-char system cap).
			const summarized =
				body.length <= 450
					? body
					: `${body.slice(0, 450)}\n[truncated — promote to see the full body]`;
			assert.strictEqual(
				row.sTokens,
				countTokens(summarized),
				"sTokens = countTokens(summarized projection)",
			);
			assert.strictEqual(
				row.aTokens,
				row.vTokens - row.sTokens,
				"aTokens delta consistent",
			);
		});
	});
});
