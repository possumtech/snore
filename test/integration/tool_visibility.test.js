/**
 * Tool visibility test.
 *
 * Covers @materialization, @schemes_status_visibility — every
 * model-visible scheme with visibility != 'archived' must have its
 * content projected through v_model_context. If a scheme's content
 * is silently dropped to '', the model can see that a tool was used
 * but not what it returned — causing infinite retry loops.
 *
 * This test writes a known value for each visible scheme, materializes
 * turn_context via the engine, and asserts the content survived.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;
const TURN = 1;
const MARKER = "VISIBILITY_TEST_CONTENT";

describe("Tool visibility: v_model_context content projection", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create();
		store = new Entries(tdb.db);
		const seed = await tdb.seedRun();
		RUN_ID = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("every model-visible result scheme projects content through the view", async () => {
		// All model-visible result schemes from 001_initial_schema.sql.
		// Every tool result needs content the model can understand —
		// what the tool did and what happened.
		const contentSchemes = [
			{ name: "set", state: "resolved" },
			{ name: "sh", state: "resolved" },
			{ name: "env", state: "resolved" },
			{ name: "rm", state: "resolved" },
			{ name: "ask_user", state: "resolved" },
			{ name: "mv", state: "resolved" },
			{ name: "cp", state: "resolved" },
			{ name: "search", state: "resolved" },
			{ name: "set", state: "resolved" },
		];

		// For each result scheme, insert an entry with known content
		for (const { name: scheme, status } of contentSchemes) {
			await store.set({
				runId: RUN_ID,
				turn: TURN,
				path: `${scheme}://${scheme}_test`,
				body: `${MARKER}_${scheme}`,
				state: status,
				attributes: { tool: scheme, target: "test" },
			});
		}

		// Also insert user prompt so engine has something to work with
		await store.set({
			runId: RUN_ID,
			turn: TURN,
			path: `prompt://${TURN}`,
			body: "test question",
			state: "resolved",
			attributes: { mode: "ask" },
		});

		// Materialize turn_context
		await materialize(tdb.db, {
			runId: RUN_ID,
			turn: TURN,
			systemPrompt: "test",
		});

		// Read materialized turn_context
		const rows = await tdb.db.get_turn_context.all({
			run_id: RUN_ID,
			turn: TURN,
		});

		// For each result scheme, verify its content survived materialization
		const failures = [];
		for (const { name: scheme } of contentSchemes) {
			const row = rows.find((r) => r.path === `${scheme}://${scheme}_test`);

			if (!row) {
				failures.push(`${scheme}: not in turn_context (filtered out by view)`);
				continue;
			}

			if (!row.body?.includes(MARKER)) {
				failures.push(
					`${scheme}: content is ${row.body ? `"${row.body.slice(0, 50)}"` : "EMPTY"} — expected "${MARKER}_${scheme}"`,
				);
			}
		}

		assert.equal(
			failures.length,
			0,
			`Schemes with invisible content:\n  ${failures.join("\n  ")}`,
		);
	});

	it("log://turn_N/<action>/ entries (the production path) project content", async () => {
		// After the unified-log-namespace migration, tool results don't
		// live at `<action>://<slug>` — they live at
		// `log://turn_N/<action>/<slug>`. Production code never writes to
		// the scheme-native paths the first test uses; that test exercises
		// a hypothetical. This one exercises the real path every tool
		// produces.
		const actions = ["set", "get", "rm", "sh", "env", "search", "ask_user"];
		for (const action of actions) {
			const path = await store.logPath(RUN_ID, TURN, action, `probe_${action}`);
			await store.set({
				runId: RUN_ID,
				turn: TURN,
				path,
				body: `${MARKER}_${action}`,
				state: "resolved",
				attributes: { path: `probe_${action}` },
			});
		}

		await store.set({
			runId: RUN_ID,
			turn: TURN,
			path: `prompt://${TURN}`,
			body: "test question",
			state: "resolved",
			attributes: { mode: "ask" },
		});

		await materialize(tdb.db, {
			runId: RUN_ID,
			turn: TURN,
			systemPrompt: "test",
		});

		const rows = await tdb.db.get_turn_context.all({
			run_id: RUN_ID,
			turn: TURN,
		});

		const failures = [];
		for (const action of actions) {
			const row = rows.find(
				(r) =>
					r.path.startsWith(`log://turn_${TURN}/${action}/`) &&
					r.body?.includes(`${MARKER}_${action}`),
			);
			if (!row) {
				failures.push(
					`${action}: no log://turn_${TURN}/${action}/ row with MARKER`,
				);
			}
		}

		assert.equal(
			failures.length,
			0,
			`log:// rows with invisible content:\n  ${failures.join("\n  ")}`,
		);
	});
});
