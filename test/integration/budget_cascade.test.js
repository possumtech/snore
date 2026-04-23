/**
 * Budget ceiling enforcement.
 *
 * Covers @budget_enforcement — the pre-LLM check that materialized
 * context fits under `ceiling(contextSize)`, returning overflow
 * when it doesn't.
 */
import assert from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

function pad(n) {
	return Array(n).fill("hello world test data").join(" ");
}

describe("budget ceiling check (@budget_enforcement, @plugins_budget, @budget_plugin)", () => {
	let tdb, store, cascade, RUN_ID;

	before(async () => {
		tdb = await TestDb.create("budget_cascade");
		store = new Entries(tdb.db);
		cascade = tdb.hooks.budget;
		const seed = await tdb.seedRun({ alias: "budget_1" });
		RUN_ID = seed.runId;
	});

	beforeEach(async () => {
		await store.rm({ runId: RUN_ID, path: "**", pattern: true });
	});

	after(async () => {
		await tdb.cleanup();
	});

	async function assembleAndEnforce(contextSize) {
		const turn = 1;
		const systemPrompt = "test";
		await materialize(tdb.db, { runId: RUN_ID, turn, systemPrompt });

		const rows = await tdb.db.get_turn_context.all({ run_id: RUN_ID, turn });
		const messages = [
			{ role: "system", content: systemPrompt },
			{
				role: "user",
				content: rows
					.filter((r) => r.path !== "system://prompt")
					.map((r) => r.body)
					.join("\n"),
			},
		];

		return cascade.enforce({
			contextSize,
			messages,
			rows,
			ctx: { runId: RUN_ID, turn: 1, loopId: 0, loopIteration: 0 },
			rummy: {
				entries: store,
				hooks: { error: { log: { emit: async () => {} } } },
			},
		});
	}

	it("ok when under budget", async () => {
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "known://small",
			body: "a small fact",
			state: "resolved",
		});
		const result = await assembleAndEnforce(100000);
		assert.strictEqual(result.ok, true);
	});

	it("overflow when over budget", async () => {
		for (let i = 0; i < 10; i++) {
			await store.set({
				runId: RUN_ID,
				turn: i + 1,
				path: `known://fact_${i}`,
				body: pad(50),
				state: "resolved",
			});
		}
		const result = await assembleAndEnforce(100);
		assert.strictEqual(result.ok, false);
		assert.ok(result.overflow > 0, "should report overflow amount");
	});

	it("overflow reports exact token count over ceiling", async () => {
		for (let i = 0; i < 5; i++) {
			await store.set({
				runId: RUN_ID,
				turn: i + 1,
				path: `known://fact_${i}`,
				body: pad(20),
				state: "resolved",
			});
		}
		const result = await assembleAndEnforce(100);
		assert.strictEqual(result.ok, false);
		assert.strictEqual(
			result.overflow,
			result.assembledTokens - Math.floor(100 * 0.9),
			"overflow should equal assembledTokens minus 90% ceiling",
		);
	});

	it("assembledTokens returned whether ok or overflow", async () => {
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "known://a",
			body: "fact",
			state: "resolved",
		});

		const ok = await assembleAndEnforce(100000);
		assert.ok(
			ok.assembledTokens > 0,
			"ok result should include assembledTokens",
		);

		for (let i = 0; i < 10; i++) {
			await store.set({
				runId: RUN_ID,
				turn: i + 2,
				path: `known://b_${i}`,
				body: pad(50),
				state: "resolved",
			});
		}
		const over = await assembleAndEnforce(100);
		assert.ok(
			over.assembledTokens > 0,
			"overflow result should include assembledTokens",
		);
	});
});
