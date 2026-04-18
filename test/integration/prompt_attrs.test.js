/**
 * Prompt attrs math verification.
 *
 * The `<prompt>` element carries two numeric attrs the model reads to
 * do budget arithmetic:
 *   tokenBudget="N" tokenUsage="M"
 *
 * Contract:
 * - tokenUsage = sum of entry.tokens for entries where
 *     (category === "data" || category === "logging") && fidelity === "promoted"
 * - tokenBudget = floor(contextSize * CEILING_RATIO) - baselineTokens
 *
 * The model can predict the effect of promote/demote actions exactly:
 * promoting an entry adds entry.tokens to tokenUsage; demoting subtracts it.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import ContextAssembler from "../../src/agent/ContextAssembler.js";
import Repository from "../../src/agent/Repository.js";
import { countTokens } from "../../src/agent/tokens.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

const CEILING_RATIO = Number(process.env.RUMMY_BUDGET_CEILING);

function pad(n) {
	return Array(n).fill("hello world test data").join(" ");
}

function parsePromptAttrs(userMessage) {
	const budget = userMessage.match(/tokenBudget="(\d+)"/);
	const usage = userMessage.match(/tokenUsage="(\d+)"/);
	if (!budget || !usage) return null;
	return {
		used: Number(usage[1]),
		budget: Number(budget[1]),
	};
}

async function assemble(tdb, runId, turn, contextSize = 32768) {
	const rows = await tdb.db.get_turn_context.all({ run_id: runId, turn });

	const baselineRows = rows.filter(
		(r) =>
			!(
				(r.category === "data" || r.category === "logging") &&
				r.fidelity === "promoted"
			),
	);
	const baselineMessages = await ContextAssembler.assembleFromTurnContext(
		baselineRows,
		{ systemPrompt: "test", contextSize, turn },
		tdb.hooks,
	);
	const baselineTokens = baselineMessages.reduce(
		(s, m) => s + countTokens(m.content),
		0,
	);

	const messages = await ContextAssembler.assembleFromTurnContext(
		rows,
		{ systemPrompt: "test", contextSize, turn, baselineTokens },
		tdb.hooks,
	);
	return { messages, baselineTokens };
}

describe("Progress math", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create("progress_math");
		store = new Repository(tdb.db);
		await store.loadSchemes(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("used tokens", () => {
		it("used = 0 when no promoted controllable entries", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_used_zero" });
			await store.set({
				runId,
				turn: 1,
				path: "prompt://1",
				body: "do thing",
				state: "resolved",
				attributes: { mode: "ask" },
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const { messages } = await assemble(tdb, runId, 1);
			const nums = parsePromptAttrs(messages[1].content);
			assert.ok(nums, "prompt attrs parsed");
			assert.strictEqual(nums.used, 0);
		});

		it("used equals tokens of single promoted known", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_used_one" });
			await store.set({
				runId,
				turn: 1,
				path: "prompt://1",
				body: "do thing",
				state: "resolved",
				attributes: { mode: "ask" },
			});
			const body = pad(50);
			await store.set({
				runId,
				turn: 1,
				path: "known://fact",
				body,
				state: "resolved",
				fidelity: "promoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const knownRow = rows.find((r) => r.path === "known://fact");
			const { messages } = await assemble(tdb, runId, 1);
			const nums = parsePromptAttrs(messages[1].content);
			assert.strictEqual(nums.used, knownRow.tokens);
		});

		it("used sums across multiple promoted entries", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_used_sum" });
			await store.set({
				runId,
				turn: 1,
				path: "prompt://1",
				body: "do thing",
				state: "resolved",
				attributes: { mode: "ask" },
			});
			await store.set({
				runId,
				turn: 1,
				path: "known://a",
				body: pad(40),
				state: "resolved",
				fidelity: "promoted",
			});
			await store.set({
				runId,
				turn: 1,
				path: "known://b",
				body: pad(60),
				state: "resolved",
				fidelity: "promoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const expected =
				rows.find((r) => r.path === "known://a").tokens +
				rows.find((r) => r.path === "known://b").tokens;
			const { messages } = await assemble(tdb, runId, 1);
			const nums = parsePromptAttrs(messages[1].content);
			assert.strictEqual(nums.used, expected);
		});

		it("demoted entries do not contribute to used", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_used_demoted" });
			await store.set({
				runId,
				turn: 1,
				path: "prompt://1",
				body: "do thing",
				state: "resolved",
				attributes: { mode: "ask" },
			});
			await store.set({
				runId,
				turn: 1,
				path: "known://kept",
				body: pad(40),
				state: "resolved",
				fidelity: "promoted",
			});
			await store.set({
				runId,
				turn: 1,
				path: "known://hidden",
				body: pad(80),
				state: "resolved",
				fidelity: "demoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const promotedTokens = rows.find((r) => r.path === "known://kept").tokens;
			const { messages } = await assemble(tdb, runId, 1);
			const nums = parsePromptAttrs(messages[1].content);
			assert.strictEqual(
				nums.used,
				promotedTokens,
				"demoted known excluded from used",
			);
		});

		it("prompt/unknown/system entries do not contribute to used", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_used_categories" });
			await store.set({
				runId,
				turn: 1,
				path: "prompt://1",
				body: pad(20),
				state: "resolved",
				attributes: { mode: "ask" },
			});
			await store.set({
				runId,
				turn: 1,
				path: "unknown://gap",
				body: "what about X?",
				state: "resolved",
				fidelity: "promoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const { messages } = await assemble(tdb, runId, 1);
			const nums = parsePromptAttrs(messages[1].content);
			assert.strictEqual(nums.used, 0, "no promoted data/logging → used = 0");
		});
	});

	describe("budget tokens", () => {
		it("budget = ceiling - baselineTokens", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_budget" });
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
			const { messages, baselineTokens } = await assemble(
				tdb,
				runId,
				1,
				contextSize,
			);
			const nums = parsePromptAttrs(messages[1].content);
			assert.strictEqual(nums.budget, Math.max(0, ceiling - baselineTokens));
		});
	});

	describe("model action causality", () => {
		it("promoting a demoted known increases used by exactly entry.tokens", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_promote" });
			await store.set({
				runId,
				turn: 1,
				path: "prompt://1",
				body: "do thing",
				state: "resolved",
				attributes: { mode: "ask" },
			});
			await store.set({
				runId,
				turn: 1,
				path: "known://x",
				body: pad(75),
				state: "resolved",
				fidelity: "demoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });

			const before = parsePromptAttrs(
				(await assemble(tdb, runId, 1)).messages[1].content,
			);
			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const entryTokens = rows.find((r) => r.path === "known://x").tokens;

			// Promote
			await store.set({
				runId: runId,
				path: "known://x",
				fidelity: "promoted",
			});
			await materialize(tdb.db, { runId, turn: 2, systemPrompt: "sys" });

			const after = parsePromptAttrs(
				(await assemble(tdb, runId, 2)).messages[1].content,
			);
			assert.strictEqual(
				after.used - before.used,
				entryTokens,
				"used increases by exactly the entry's tokens",
			);
		});

		it("demoting a promoted known decreases used by exactly entry.tokens", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_demote" });
			await store.set({
				runId,
				turn: 1,
				path: "prompt://1",
				body: "do thing",
				state: "resolved",
				attributes: { mode: "ask" },
			});
			await store.set({
				runId,
				turn: 1,
				path: "known://y",
				body: pad(60),
				state: "resolved",
				fidelity: "promoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });

			const before = parsePromptAttrs(
				(await assemble(tdb, runId, 1)).messages[1].content,
			);
			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const entryTokens = rows.find((r) => r.path === "known://y").tokens;

			// Demote
			await store.set({ runId: runId, path: "known://y", fidelity: "demoted" });
			await materialize(tdb.db, { runId, turn: 2, systemPrompt: "sys" });

			const after = parsePromptAttrs(
				(await assemble(tdb, runId, 2)).messages[1].content,
			);
			assert.strictEqual(
				before.used - after.used,
				entryTokens,
				"used decreases by exactly the entry's tokens",
			);
		});
	});
});
