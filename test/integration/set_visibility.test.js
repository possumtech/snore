/**
 * Set plugin: visibility-only sets must NOT wipe the body.
 *
 * Covers @schemes_status_visibility, @budget_enforcement.
 *
 * Regression: `VALID_VISIBILITY` in set.js held the pre-migration
 * terminology (`archived|demoted|promoted`). Any model emission like
 *   <set path="https://..." visibility="visible"/>
 * would fail the whitelist check, `visibilityAttr` became null, the
 * pure-visibility branch was skipped, and control fell through to the
 * "direct scheme write" branch which treated the empty body as a
 * replacement. Source URLs, knowns, and unknowns all silently got
 * body-wiped every time the model used a visibility=visible|summarized
 * attribute.
 *
 * rummy_dev.db::test:demo run 1776987211091 cycled for 15 turns
 * re-getting the same Purdue source URL because T3's
 * `<set path=URL visibility="visible"/>` had wiped its 1194-token body
 * to 0 bytes. Each subsequent get saw empty content, re-tried, loop
 * detected, run abandoned.
 *
 * Contract: a self-closing `<set path=X visibility=V/>` MUST preserve
 * the body and only flip the visibility attribute — for every valid V.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import SetPlugin from "../../src/plugins/set/set.js";
import TestDb from "../helpers/TestDb.js";

function makeRummy(store, runId, turn) {
	const errors = [];
	return {
		entries: store,
		runId,
		sequence: turn,
		loopId: null,
		hooks: {
			error: {
				log: { emit: async (payload) => errors.push(payload) },
			},
		},
		_errors: errors,
	};
}

function makeCore() {
	return {
		registerScheme: () => {},
		ensureTool: () => {},
		on: () => {},
		filter: () => {},
		hooks: {
			entry: { recording: { addFilter: () => {} } },
			tools: { onView: () => {} },
		},
	};
}

describe("Set visibility-only emission preserves body (@schemes_status_visibility)", () => {
	let tdb, store, plugin;

	before(async () => {
		tdb = await TestDb.create("set_visibility");
		store = new Entries(tdb.db);
		await store.loadSchemes(tdb.db);
		plugin = new SetPlugin(makeCore());
	});

	after(async () => {
		await tdb.cleanup();
	});

	async function seedAndFlip(runAlias, path, initialBody, visibility) {
		const { runId } = await tdb.seedRun({ alias: runAlias });
		await store.set({
			runId,
			turn: 1,
			path,
			body: initialBody,
			state: "resolved",
			visibility: "visible",
		});
		const rummy = makeRummy(store, runId, 2);
		const entry = {
			scheme: "set",
			attributes: { path, visibility },
			body: "",
			resultPath: `log://turn_2/set/${encodeURIComponent(path)}`,
		};
		await plugin.handler(entry, rummy);
		const [after] = await tdb.db.get_entries_by_pattern.all({
			run_id: runId,
			path,
			body: null,
			limit: null,
			offset: null,
		});
		return after;
	}

	for (const visibility of ["visible", "summarized", "archived"]) {
		it(`<set path=X visibility="${visibility}"/> preserves body (does NOT wipe)`, async () => {
			const body =
				"A page full of content that must survive a visibility flip.";
			const path = `https://example.com/${visibility}-test`;
			const after = await seedAndFlip(
				`svis_${visibility}`,
				path,
				body,
				visibility,
			);
			assert.strictEqual(
				after.body,
				body,
				`visibility="${visibility}" must not wipe body; got: ${JSON.stringify(after.body)}`,
			);
			assert.strictEqual(
				after.visibility,
				visibility,
				`visibility attribute flipped to ${visibility}`,
			);
		});
	}

	it("unknown visibility value rejected with actionable error — body untouched", async () => {
		const body = "Original content";
		const path = "https://example.com/invalid-visibility";
		const { runId } = await tdb.seedRun({ alias: "svis_invalid" });
		await store.set({
			runId,
			turn: 1,
			path,
			body,
			state: "resolved",
			visibility: "visible",
		});
		const entry = {
			scheme: "set",
			attributes: { path, visibility: "promoted" }, // stale terminology
			body: "",
			resultPath: "log://turn_2/set/bogus",
		};
		const rummy = makeRummy(store, runId, 2);
		await plugin.handler(entry, rummy);
		const [after] = await tdb.db.get_entries_by_pattern.all({
			run_id: runId,
			path,
			body: null,
			limit: null,
			offset: null,
		});
		assert.strictEqual(
			after.body,
			body,
			"unknown visibility value must not wipe the body",
		);
		assert.strictEqual(
			after.visibility,
			"visible",
			"unknown visibility value leaves the current visibility untouched",
		);
		assert.strictEqual(
			rummy._errors.length,
			0,
			"no error.log emission — action entry IS its outcome",
		);
		const [resultEntry] = await tdb.db.get_entries_by_pattern.all({
			run_id: runId,
			path: "log://turn_2/set/bogus",
			body: null,
			limit: null,
			offset: null,
		});
		assert.ok(resultEntry, "action entry was finalized");
		assert.strictEqual(resultEntry.state, "failed");
		assert.strictEqual(resultEntry.outcome, "validation");
		assert.ok(
			resultEntry.body.includes("promoted"),
			"action body names the bad value",
		);
		assert.ok(
			resultEntry.body.includes("visible|summarized|archived"),
			"action body lists valid values",
		);
	});
});
