/**
 * getEntriesByPattern with `since` cursor.
 *
 * Covers @plugins_rummy_queries — the incremental-sync mechanism that
 * pairs with the `run/changed` pulse: clients track last-seen entry id,
 * receive a pulse, query with `since` to fetch the diff. Insertion-order
 * delivery so chunked catch-up is well-defined.
 */
import assert from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("getEntriesByPattern since-mode (@plugins_rummy_queries)", () => {
	let tdb;
	let store;
	let RUN_ID;
	let seq = 0;

	before(async () => {
		tdb = await TestDb.create("entries_since");
		store = new Entries(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	beforeEach(async () => {
		// Fresh run per test so entries don't leak between cases.
		seq += 1;
		const seed = await tdb.seedRun({ alias: `since_test_${seq}` });
		RUN_ID = seed.runId;
	});

	it("returns nothing when no entries exist past `since`", async () => {
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "known://a",
			body: "alpha",
			state: "resolved",
		});
		const [seed] = await store.getEntriesByPattern(RUN_ID, "known://a");
		assert.ok(seed?.id, "seed entry has id");
		const diff = await store.getEntriesByPattern(RUN_ID, "**", null, {
			since: seed.id,
		});
		assert.strictEqual(diff.length, 0, "no entries past the latest id");
	});

	it("returns only entries with id > since, in insertion order", async () => {
		const a = await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "known://a",
			body: "alpha",
			state: "resolved",
		});
		const [aRow] = await store.getEntriesByPattern(RUN_ID, "known://a");
		const sinceId = aRow.id;

		await store.set({
			runId: RUN_ID,
			turn: 2,
			path: "known://b",
			body: "beta",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 3,
			path: "known://c",
			body: "gamma",
			state: "resolved",
		});

		const diff = await store.getEntriesByPattern(RUN_ID, "**", null, {
			since: sinceId,
		});
		assert.strictEqual(diff.length, 2, "only entries past sinceId");
		assert.deepStrictEqual(
			diff.map((e) => e.path),
			["known://b", "known://c"],
			"insertion order preserved",
		);
	});

	it("respects limit when chunking catch-up", async () => {
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "known://1",
			body: "1",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 2,
			path: "known://2",
			body: "2",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 3,
			path: "known://3",
			body: "3",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 4,
			path: "known://4",
			body: "4",
			state: "resolved",
		});

		const firstChunk = await store.getEntriesByPattern(RUN_ID, "**", null, {
			since: 0,
			limit: 2,
		});
		assert.strictEqual(firstChunk.length, 2);
		const lastSeen = firstChunk[firstChunk.length - 1].id;

		const secondChunk = await store.getEntriesByPattern(RUN_ID, "**", null, {
			since: lastSeen,
			limit: 2,
		});
		assert.strictEqual(secondChunk.length, 2);
		assert.deepStrictEqual(
			[...firstChunk, ...secondChunk].map((e) => e.path),
			["known://1", "known://2", "known://3", "known://4"],
			"chunked retrieval reconstructs full insertion-order sequence",
		);
	});

	it("path-only mode (no `since`) preserves alphabetical ordering for browsing", async () => {
		await store.set({
			runId: RUN_ID,
			turn: 1,
			path: "known://zebra",
			body: "z",
			state: "resolved",
		});
		await store.set({
			runId: RUN_ID,
			turn: 2,
			path: "known://apple",
			body: "a",
			state: "resolved",
		});
		const browse = await store.getEntriesByPattern(RUN_ID, "known://*");
		assert.deepStrictEqual(
			browse.map((e) => e.path),
			["known://apple", "known://zebra"],
			"browse mode orders by path (not insertion)",
		);
	});
});
