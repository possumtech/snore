/**
 * Prompt attrs math verification.
 *
 * Covers @key_entries, @budget_enforcement, @prompt_plugin —
 * the `<prompt>` element carries numeric attrs the model reads
 * to do budget arithmetic:
 *   tokenUsage="N" tokensFree="M"
 *
 * Contract:
 * - tokenUsage = total packet size (actual API input tokens from
 *   prior turn on turn 2+; measureRows estimate on turn 1 — the
 *   assembled-context projection is ~3-7× under for XML-heavy
 *   content and we accept that tolerance on turn 1 only).
 * - tokensFree = max(0, ceiling - tokenUsage)
 *
 * The wire contract is honest: tokenUsage reflects what the LLM
 * actually charged last turn, not an internal sub-measurement.
 * See `@budget_enforcement` and budget_math.test.js for the full
 * signal correctness suite.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import ContextAssembler from "../../src/agent/ContextAssembler.js";
import Entries from "../../src/agent/Entries.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

const CEILING_RATIO = Number(process.env.RUMMY_BUDGET_CEILING);

function pad(n) {
	return Array(n).fill("hello world test data").join(" ");
}

function parsePromptAttrs(userMessage) {
	const usage = userMessage.match(/tokenUsage="(\d+)"/);
	const free = userMessage.match(/tokensFree="(\d+)"/);
	if (!usage || !free) return null;
	return {
		used: Number(usage[1]),
		free: Number(free[1]),
	};
}

async function assemble(tdb, runId, turn, contextSize = 32768) {
	const rows = await tdb.db.get_turn_context.all({ run_id: runId, turn });
	const messages = await ContextAssembler.assembleFromTurnContext(
		rows,
		{ systemPrompt: "test", contextSize, turn },
		tdb.hooks,
	);
	return { messages, rows };
}

describe("Progress math", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create("progress_math");
		store = new Entries(tdb.db);
		await store.loadSchemes(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("free tokens", () => {
		it("tokensFree equals ceiling minus total row tokens when under ceiling", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_free" });
			const contextSize = 32768;
			const ceiling = Math.floor(contextSize * CEILING_RATIO);
			await store.set({
				runId,
				turn: 1,
				path: "prompt://1",
				body: "do thing",
				state: "resolved",
				attributes: { mode: "ask" },
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const { messages, rows } = await assemble(tdb, runId, 1, contextSize);
			const nums = parsePromptAttrs(messages[1].content);
			const rowSum = rows.reduce((s, r) => s + (r.tokens || 0), 0);
			assert.strictEqual(nums.free, Math.max(0, ceiling - rowSum));
		});
	});

});
