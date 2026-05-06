/**
 * Entry-size CHECK constraint (@entries — RUMMY_ENTRY_SIZE_MAX) end-to-end.
 *
 * Covers the storage-layer body cap baked into entries.body via the
 * SqlRite $entry_size_max param substitution, plus the centralized
 * Entries.set onError translation that converts the SQLITE_CONSTRAINT_CHECK
 * failure into an EntryOverflowError. The strike-emission wiring
 * (ProjectAgent → hooks.error.log) is exercised by the unit suite.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import { EntryOverflowError } from "../../src/agent/errors.js";
import TestDb from "../helpers/TestDb.js";

// Per-test cap: keeps allocations cheap without forcing a global env
// override. Behavior is identical at any cap value — test exercises the
// CHECK boundary, not a specific number.
const TEST_CAP = 1024;

describe("entry overflow (@entries, RUMMY_ENTRY_SIZE_MAX)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("entry_overflow", { entrySizeMax: TEST_CAP });
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("oversized body triggers EntryOverflowError; onError swallows it", async () => {
		const { runId } = await tdb.seedRun({ alias: "overflow_huge" });
		const cap = TEST_CAP;
		const events = [];
		const store = new Entries(tdb.db, {
			onError: (event) => events.push(event),
		});
		await store.loadSchemes();
		const huge = "x".repeat(cap + 1);
		await store.set({
			runId,
			turn: 1,
			path: "data://test/huge",
			body: huge,
			loopId: 99,
		});
		assert.equal(events.length, 1, "onError called once");
		assert.ok(
			events[0].error instanceof EntryOverflowError,
			"onError received an EntryOverflowError instance",
		);
		assert.equal(events[0].error.path, "data://test/huge");
		assert.equal(events[0].error.size, huge.length);
		assert.equal(events[0].runId, runId);
		assert.equal(events[0].loopId, 99);
		assert.equal(events[0].turn, 1);
		// Body must NOT have been written.
		const fetched = await store.getBody(runId, "data://test/huge");
		assert.equal(fetched, null, "rejected entry was not persisted");
	});

	it("body at cap is accepted; just-over-cap is rejected", async () => {
		const { runId } = await tdb.seedRun({ alias: "overflow_boundary" });
		const cap = TEST_CAP;
		const events = [];
		const store = new Entries(tdb.db, {
			onError: (event) => events.push(event),
		});
		await store.loadSchemes();
		await store.set({
			runId,
			turn: 1,
			path: "data://test/at_cap",
			body: "y".repeat(cap),
		});
		assert.equal(events.length, 0, "body at cap accepted");
		const stored = await store.getBody(runId, "data://test/at_cap");
		assert.equal(stored.length, cap);
		await store.set({
			runId,
			turn: 1,
			path: "data://test/over_cap",
			body: "y".repeat(cap + 1),
		});
		assert.equal(events.length, 1, "body just-over-cap rejected via onError");
	});

	it("append-mode that pushes existing body past cap is rejected", async () => {
		const { runId } = await tdb.seedRun({ alias: "overflow_append" });
		const cap = TEST_CAP;
		const events = [];
		const store = new Entries(tdb.db, {
			onError: (event) => events.push(event),
		});
		await store.loadSchemes();
		// Seed an existing entry near the cap.
		const seedSize = cap - 100;
		await store.set({
			runId,
			turn: 1,
			path: "data://test/append_target",
			body: "z".repeat(seedSize),
		});
		// Append that pushes past cap — CHECK fires on the resulting body length.
		await store.set({
			runId,
			append: true,
			path: "data://test/append_target",
			body: "z".repeat(200),
		});
		assert.equal(events.length, 1, "append overflow routed via onError");
		assert.ok(events[0].error instanceof EntryOverflowError);
		// Body unchanged at seed size — append was rejected, not partial.
		const stored = await store.getBody(runId, "data://test/append_target");
		assert.equal(stored.length, seedSize, "body remained at seed size");
	});

	it("set re-throws non-overflow errors without invoking onError", async () => {
		const events = [];
		const store = new Entries(tdb.db, {
			onError: (event) => events.push(event),
		});
		// Missing runId is a caller-error throw from set() — must not be
		// captured by the overflow translator.
		await assert.rejects(
			() => store.set({ path: "data://x", body: "ok" }),
			/runId is required/,
		);
		assert.equal(events.length, 0, "non-overflow errors bypass onError");
	});
});
