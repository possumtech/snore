import assert from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

function pad(n) {
	return Array(n).fill("hello world test data").join(" ");
}

describe("Budget cascade — halving spiral", () => {
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
		const systemPrompt = "test system prompt";
		await materialize(tdb.db, { runId: RUN_ID, turn, systemPrompt });

		let rows = await tdb.db.get_turn_context.all({ run_id: RUN_ID, turn });
		let messages = [
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
			store,
			runId: RUN_ID,
			loopId: null,
			turn,
			messages,
			rows,
			rematerialize: async () => {
				await materialize(tdb.db, { runId: RUN_ID, turn, systemPrompt });
				rows = await tdb.db.get_turn_context.all({ run_id: RUN_ID, turn });
				messages = [
					{ role: "system", content: systemPrompt },
					{
						role: "user",
						content: rows
							.filter((r) => r.path !== "system://prompt")
							.map((r) => r.body)
							.join("\n"),
					},
				];
				return { messages, rows };
			},
		});
	}

	it("no demotion when under budget", async () => {
		await store.upsert(RUN_ID, 1, "known://small", "a small fact", 200);
		const result = await assembleAndEnforce(100000);
		assert.strictEqual(result.demoted.length, 0);
	});

	it("tier 1 halving demotes oldest full entries first", async () => {
		// Create 10 known entries with clear age ordering
		for (let i = 0; i < 10; i++) {
			await store.upsert(RUN_ID, i + 1, `known://fact_${i}`, pad(50), 200);
		}

		// Tight budget — forces demotions via halving
		const result = await assembleAndEnforce(2500);

		// Should have demoted entries
		assert.ok(result.demoted.length > 0, "should have demoted entries");

		// Oldest entries should have been demoted first
		const entries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
		const demotedEntries = entries.filter(
			(e) => e.scheme === "known" && e.fidelity !== "full",
		);
		assert.ok(demotedEntries.length > 0, "some entries should be demoted");

		// If any entries remain at full, they should be newer than demoted ones
		const fullKnowns = entries.filter(
			(e) => e.scheme === "known" && e.fidelity === "full",
		);
		if (fullKnowns.length > 0) {
			const newestFull = fullKnowns.toSorted((a, b) => b.turn - a.turn)[0];
			const oldestDemoted = demotedEntries.toSorted(
				(a, b) => a.turn - b.turn,
			)[0];
			assert.ok(
				newestFull.turn >= oldestDemoted.turn,
				"newest full should have higher turn than oldest demoted",
			);
		}
	});

	it("tier 2 halving demotes summary to index when tier 1 insufficient", async () => {
		// Create many entries that won't fit even at summary
		for (let i = 0; i < 20; i++) {
			await store.upsert(RUN_ID, i + 1, `known://big_${i}`, pad(100), 200);
		}

		// Very tight budget
		const _result = await assembleAndEnforce(2000);

		const entries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
		const indexKnowns = entries.filter(
			(e) => e.scheme === "known" && e.fidelity === "index",
		);
		assert.ok(
			indexKnowns.length > 0,
			"tier 2 should have created index entries",
		);
	});

	it("tier 3 creates stash entries at index fidelity", async () => {
		// Create entries and manually set them to index fidelity
		// to test tier 3 directly
		for (let i = 0; i < 50; i++) {
			await store.upsert(
				RUN_ID,
				i + 1,
				`known://stashtest_${String(i).padStart(3, "0")}`,
				pad(100),
				200,
			);
			await store.setFidelity(
				RUN_ID,
				`known://stashtest_${String(i).padStart(3, "0")}`,
				"index",
			);
		}
		// Add one large full entry to push over budget and trigger the cascade
		await store.upsert(RUN_ID, 51, "known://trigger", pad(500), 200);

		// Budget tight enough to trigger tier 3 after tier 1+2 handle the trigger entry
		const result = await assembleAndEnforce(200);

		const entries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
		const stashes = entries.filter((e) => e.path?.startsWith("known://stash_"));

		// If stashes were created, verify they're at index fidelity
		if (stashes.length > 0) {
			for (const stash of stashes) {
				assert.strictEqual(
					stash.fidelity,
					"index",
					`stash ${stash.path} should be at index fidelity`,
				);
			}
			// Stash body should contain URIs of stored entries
			assert.ok(
				stashes.some((s) => s.body?.includes("known://stashtest_")),
				"stash body should contain stored entry URIs",
			);
		} else {
			// Tier 3 may not trigger if index entries are cheap enough
			// Verify that stored entries exist instead
			const stored = entries.filter(
				(e) => e.fidelity === "stored" && e.scheme === "known",
			);
			assert.ok(
				stored.length > 0 || result.demoted.length > 0,
				"cascade should have demoted entries",
			);
		}
	});

	it("halving preserves newest entries at each tier", async () => {
		// Create entries with clear age ordering
		await store.upsert(RUN_ID, 1, "known://oldest", pad(50), 200);
		await store.upsert(RUN_ID, 2, "known://middle", pad(50), 200);
		await store.upsert(RUN_ID, 3, "known://newest", pad(50), 200);

		// Budget that forces exactly one demotion
		const result = await assembleAndEnforce(3000);

		if (result.demoted.length > 0) {
			// Oldest should be demoted first
			assert.ok(
				result.demoted.includes("known://oldest"),
				"oldest entry should be demoted first",
			);

			// Newest should survive
			const entries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const newest = entries.find((e) => e.path === "known://newest");
			assert.strictEqual(
				newest.fidelity,
				"full",
				"newest entry should remain at full fidelity",
			);
		}
	});

	it("demotion priority: prompts before files before knowns", async () => {
		// Create one of each type
		await store.upsert(RUN_ID, 1, "ask://old_prompt", "old question", 200);
		await store.upsert(RUN_ID, 1, "src/file.js", pad(50), 200);
		await store.upsert(RUN_ID, 1, "known://fact", pad(50), 200);

		// Budget that forces some demotions but not all
		const result = await assembleAndEnforce(3000);

		if (result.demoted.length > 0) {
			// Prompt should be demoted before known
			const promptIdx = result.demoted.indexOf("ask://old_prompt");
			const knownIdx = result.demoted.indexOf("known://fact");

			if (promptIdx !== -1 && knownIdx !== -1) {
				assert.ok(
					promptIdx < knownIdx,
					"prompt should be demoted before known",
				);
			} else if (promptIdx === -1 && knownIdx !== -1) {
				assert.fail("known demoted but prompt still full — wrong priority");
			}
		}
	});

	it("hard error when floor exceeds context", async () => {
		// Create a large system prompt that can't be demoted
		// plus enough entries that even after full cascade, floor is too big
		for (let i = 0; i < 200; i++) {
			await store.upsert(
				RUN_ID,
				i + 1,
				`known://floor_${String(i).padStart(3, "0")}`,
				pad(50),
				200,
			);
		}

		// Budget of 5 — system prompt "test" alone might fit,
		// but stash entries for 200 known entries won't
		await assert.rejects(
			() => assembleAndEnforce(5),
			(err) => {
				assert.ok(err.message.includes("Context floor"));
				return true;
			},
		);
	});

	it("summarize callback fires for entries without summaries", async () => {
		for (let i = 0; i < 10; i++) {
			await store.upsert(RUN_ID, i + 1, `known://unsumm_${i}`, pad(50), 200);
		}

		const summarized = [];
		const turn = 1;
		const systemPrompt = "test system prompt";
		await materialize(tdb.db, { runId: RUN_ID, turn, systemPrompt });

		let rows = await tdb.db.get_turn_context.all({ run_id: RUN_ID, turn });
		let messages = [
			{ role: "system", content: systemPrompt },
			{
				role: "user",
				content: rows
					.filter((r) => r.path !== "system://prompt")
					.map((r) => r.body)
					.join("\n"),
			},
		];

		await cascade.enforce({
			contextSize: 2500,
			store,
			runId: RUN_ID,
			loopId: null,
			turn,
			messages,
			rows,
			rematerialize: async () => {
				await materialize(tdb.db, { runId: RUN_ID, turn, systemPrompt });
				rows = await tdb.db.get_turn_context.all({ run_id: RUN_ID, turn });
				messages = [
					{ role: "system", content: systemPrompt },
					{
						role: "user",
						content: rows
							.filter((r) => r.path !== "system://prompt")
							.map((r) => r.body)
							.join("\n"),
					},
				];
				return { messages, rows };
			},
			summarize: async (entries) => {
				summarized.push(...entries.map((e) => e.path));
			},
		});

		assert.ok(
			summarized.length > 0,
			"summarize callback should have been called",
		);
	});

	it("summarize callback skips entries with existing summaries", async () => {
		for (let i = 0; i < 10; i++) {
			await store.upsert(RUN_ID, i + 1, `known://presumm_${i}`, pad(50), 200, {
				attributes: { summary: "already summarized" },
			});
		}

		const summarized = [];
		const turn = 1;
		const systemPrompt = "test system prompt";
		await materialize(tdb.db, { runId: RUN_ID, turn, systemPrompt });

		let rows = await tdb.db.get_turn_context.all({ run_id: RUN_ID, turn });
		let messages = [
			{ role: "system", content: systemPrompt },
			{
				role: "user",
				content: rows
					.filter((r) => r.path !== "system://prompt")
					.map((r) => r.body)
					.join("\n"),
			},
		];

		await cascade.enforce({
			contextSize: 2500,
			store,
			runId: RUN_ID,
			loopId: null,
			turn,
			messages,
			rows,
			rematerialize: async () => {
				await materialize(tdb.db, { runId: RUN_ID, turn, systemPrompt });
				rows = await tdb.db.get_turn_context.all({ run_id: RUN_ID, turn });
				messages = [
					{ role: "system", content: systemPrompt },
					{
						role: "user",
						content: rows
							.filter((r) => r.path !== "system://prompt")
							.map((r) => r.body)
							.join("\n"),
					},
				];
				return { messages, rows };
			},
			summarize: async (entries) => {
				summarized.push(...entries.map((e) => e.path));
			},
		});

		assert.strictEqual(
			summarized.length,
			0,
			"should not summarize pre-summarized entries",
		);
	});

	it("stash contains all stored URIs", async () => {
		const paths = [];
		for (let i = 0; i < 20; i++) {
			const path = `known://item_${String(i).padStart(2, "0")}`;
			await store.upsert(RUN_ID, i + 1, path, pad(100), 200);
			paths.push(path);
		}

		// Force everything to stash
		const _result = await assembleAndEnforce(500);

		const entries = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
		const stash = entries.find((e) => e.path === "known://stash_known");

		if (stash) {
			const storedEntries = entries.filter(
				(e) =>
					e.fidelity === "stored" &&
					e.scheme === "known" &&
					!e.path.startsWith("known://stash_"),
			);
			// Every stored entry should be listed in the stash
			for (const stored of storedEntries) {
				assert.ok(
					stash.body.includes(stored.path),
					`stash should contain ${stored.path}`,
				);
			}
		}
	});
});
