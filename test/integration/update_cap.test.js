/**
 * Entries.update enforces the 80-char cap on update bodies.
 *
 * Covers @failure_reporting — the boundary chops update bodies that
 * exceed UPDATE_BODY_MAX and emits a soft error so clients receive the
 * promised ≤ 80 chars and the violation is visible to the model on the
 * next turn. Symmetric with the materializer's SUMMARY_MAX_CHARS chop +
 * soft-error pattern.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("Entries.update body cap (@failure_reporting)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("update_cap");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("body > 80 chars chops to 80 and fires onSoftError", async () => {
		const { runId } = await tdb.seedRun({ alias: "update_cap_chop" });
		const softErrors = [];
		const store = new Entries(tdb.db, {
			onSoftError: (event) => softErrors.push(event),
		});
		await store.loadSchemes();
		const giant = "x".repeat(500);
		const path = await store.update({
			runId,
			turn: 1,
			body: giant,
			status: 200,
			loopId: null,
		});
		assert.equal(softErrors.length, 1, "onSoftError fires once");
		assert.match(
			softErrors[0].message,
			/keep the update body to <= 80 characters/,
			"soft error message names the contract",
		);
		const stored = await tdb.db.get_entry_body.get({ run_id: runId, path });
		assert.equal(stored.body.length, 80, "stored body is chopped to 80");
		assert.equal(stored.body, "x".repeat(80));
	});

	it("body <= 80 chars passes through untouched, no soft error", async () => {
		const { runId } = await tdb.seedRun({ alias: "update_cap_ok" });
		const softErrors = [];
		const store = new Entries(tdb.db, {
			onSoftError: (event) => softErrors.push(event),
		});
		await store.loadSchemes();
		const fine = "Report delivered in OC_RIVERS.md";
		const path = await store.update({
			runId,
			turn: 1,
			body: fine,
			status: 200,
			loopId: null,
		});
		assert.equal(softErrors.length, 0, "onSoftError did not fire");
		const stored = await tdb.db.get_entry_body.get({ run_id: runId, path });
		assert.equal(stored.body, fine);
	});
});
