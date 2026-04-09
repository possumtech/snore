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

	it("no crash when under budget", async () => {
		await store.upsert(RUN_ID, 1, "known://small", "a small fact", 200);
		const result = await assembleAndEnforce(100000);
		assert.strictEqual(result.demoted.length, 0);
	});

	it("crash when over budget", async () => {
		for (let i = 0; i < 10; i++) {
			await store.upsert(RUN_ID, i + 1, `known://fact_${i}`, pad(50), 200);
		}

		await assert.rejects(
			() => assembleAndEnforce(100),
			(err) => {
				assert.ok(err.message.includes("exceeds model limit"));
				return true;
			},
		);
	});

	it("passes when entries fit within budget", async () => {
		await store.upsert(RUN_ID, 1, "known://a", "fact one", 200);
		await store.upsert(RUN_ID, 2, "known://b", "fact two", 200);

		const result = await assembleAndEnforce(50000);
		assert.strictEqual(result.demoted.length, 0);
	});
});
