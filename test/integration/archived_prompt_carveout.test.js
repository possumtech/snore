/**
 * Archived prompts retain their body end-to-end.
 *
 * Covers @prompt_plugin, @key_entries — the active prompt must remain
 * discoverable to the model after FCRM Demotion archives it. The
 * v_model_context view has a documented carve-out (`Archived prompts
 * pass through; see prompt plugin README`); this test pins both layers
 * of that contract:
 *   1. SQL view returns archived prompts with body intact.
 *   2. The full materialize → assemble chain renders <prompt>body</prompt>
 *      so the model sees what was asked even after Demotion.
 *
 * Regression context: a 2026-04-29 stories e2e run failed because the
 * second CTE's body projection (`CASE WHEN visibility IN ('visible',
 * 'summarized') THEN body ELSE ''`) silently zeroed archived prompts'
 * bodies. The first CTE preserved the row; the second stripped its
 * content. Model in Deployment Stage saw an empty <prompt> tag and
 * emitted "please provide a prompt to act upon" instead of answering.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import materializeContext from "../../src/agent/materializeContext.js";
import TestDb from "../helpers/TestDb.js";

const PROMPT_BODY = "What is the project codename in notes.md?";

describe("Archived prompt carve-out (@prompt_plugin, @key_entries)", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create("archived_prompt_carveout");
		store = new Entries(tdb.db);
		await store.loadSchemes(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("v_model_context preserves body for archived prompt entries", async () => {
		const { runId } = await tdb.seedRun({ alias: "carveout_view" });
		await store.set({
			runId,
			turn: 1,
			path: "prompt://1",
			body: PROMPT_BODY,
			state: "resolved",
			attributes: { mode: "ask" },
		});
		await store.set({
			runId,
			path: "prompt://1",
			visibility: "archived",
		});

		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const promptRow = rows.find((r) => r.path === "prompt://1");

		assert.ok(
			promptRow,
			"archived prompt must remain visible in v_model_context (CTE 1 carve-out)",
		);
		assert.strictEqual(promptRow.visibility, "archived");
		assert.strictEqual(
			promptRow.body,
			PROMPT_BODY,
			"archived prompt body must be preserved (CTE 2 carve-out)",
		);
	});

	it("v_model_context still zeroes body for archived non-prompt entries", async () => {
		const { runId } = await tdb.seedRun({ alias: "carveout_nonprompt" });
		await store.set({
			runId,
			turn: 1,
			path: "known://example/topic",
			body: "some knowledge body",
			state: "resolved",
		});
		await store.set({
			runId,
			path: "known://example/topic",
			visibility: "archived",
		});

		const rows = await tdb.db.get_model_context.all({ run_id: runId });
		const knownRow = rows.find((r) => r.path === "known://example/topic");

		// CTE 1 already excludes archived non-prompt entries (effective_visibility = NULL);
		// they should be absent from v_model_context entirely.
		assert.strictEqual(
			knownRow,
			undefined,
			"archived non-prompt entries must not appear in v_model_context",
		);
	});

	it("rendered <prompt> tag includes body for archived prompts (full chain)", async () => {
		const { runId } = await tdb.seedRun({ alias: "carveout_render" });
		await store.set({
			runId,
			turn: 1,
			path: "prompt://1",
			body: PROMPT_BODY,
			state: "resolved",
			attributes: { mode: "ask" },
		});
		await store.set({
			runId,
			path: "prompt://1",
			visibility: "archived",
		});

		const { messages } = await materializeContext({
			db: tdb.db,
			hooks: tdb.hooks,
			runId,
			loopId: null,
			turn: 1,
			systemPrompt: "sys",
			mode: "ask",
			toolSet: null,
			contextSize: 32768,
		});

		const userMessage = messages[1].content;
		const expectedFragment = `>${PROMPT_BODY}</prompt>`;
		assert.ok(
			userMessage.includes(expectedFragment),
			`archived prompt should render with body in <prompt> tag; tail: ${userMessage.slice(-300)}`,
		);
	});
});
