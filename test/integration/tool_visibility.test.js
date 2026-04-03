/**
 * Tool visibility test.
 *
 * Every model-visible scheme with fidelity != 'null' must have its content
 * projected through v_model_context. If a scheme's content is silently
 * dropped to '', the model can see that a tool was used but not what it
 * returned — causing infinite retry loops.
 *
 * This test writes a known value for each visible scheme, materializes
 * turn_context via the engine, and asserts the content survived.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;
const TURN = 1;
const MARKER = "VISIBILITY_TEST_CONTENT";

describe("Tool visibility: v_model_context content projection", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
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
			{ name: "write", state: "pass" },
			{ name: "run", state: "pass" },
			{ name: "env", state: "pass" },
			{ name: "delete", state: "pass" },
			{ name: "ask_user", state: "pass" },
			{ name: "move", state: "pass" },
			{ name: "copy", state: "pass" },
			{ name: "search", state: "info" },
			{ name: "write", state: "pattern" },
		];

		// For each result scheme, insert an entry with known content
		for (const { name: scheme, state } of contentSchemes) {
			await store.upsert(
				RUN_ID,
				TURN,
				`${scheme}://${scheme}_test`,
				`${MARKER}_${scheme}`,
				state,
				{ attributes: { tool: scheme, target: "test" } },
			);
		}

		// Also insert user prompt so engine has something to work with
		await store.upsert(RUN_ID, TURN, `ask://${TURN}`, "test question", "info");

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
});
