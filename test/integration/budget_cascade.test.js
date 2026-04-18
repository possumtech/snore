import assert from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

function pad(n) {
	return Array(n).fill("hello world test data").join(" ");
}

describe("Budget — ceiling check", () => {
	let tdb, store, cascade, RUN_ID;

	before(async () => {
		tdb = await TestDb.create("budget_cascade");
		store = new KnownStore(tdb.db);
		cascade = tdb.hooks.budget;
		const seed = await tdb.seedRun({ alias: "budget_1" });
		RUN_ID = seed.runId;
	});

	beforeEach(async () => {
		await store.deleteByPattern(RUN_ID, "**", null);
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
		});
	}

	it("ok when under budget", async () => {
		await store.upsert(RUN_ID, 1, "known://small", "a small fact", "resolved");
		const result = await assembleAndEnforce(100000);
		assert.strictEqual(result.ok, true);
	});

	it("overflow when over budget", async () => {
		for (let i = 0; i < 10; i++) {
			await store.upsert(
				RUN_ID,
				i + 1,
				`known://fact_${i}`,
				pad(50),
				"resolved",
			);
		}
		const result = await assembleAndEnforce(100);
		assert.strictEqual(result.ok, false);
		assert.ok(result.overflow > 0, "should report overflow amount");
	});

	it("overflow reports exact token count over ceiling", async () => {
		for (let i = 0; i < 5; i++) {
			await store.upsert(
				RUN_ID,
				i + 1,
				`known://fact_${i}`,
				pad(20),
				"resolved",
			);
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
		await store.upsert(RUN_ID, 1, "known://a", "fact", "resolved");

		const ok = await assembleAndEnforce(100000);
		assert.ok(
			ok.assembledTokens > 0,
			"ok result should include assembledTokens",
		);

		for (let i = 0; i < 10; i++) {
			await store.upsert(RUN_ID, i + 2, `known://b_${i}`, pad(50), "resolved");
		}
		const over = await assembleAndEnforce(100);
		assert.ok(
			over.assembledTokens > 0,
			"overflow result should include assembledTokens",
		);
	});
});
