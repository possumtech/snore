/**
 * Progress message math verification.
 *
 * The progress message tells the model:
 *   "Using <used> of <budget> tokens. <remaining> tokens remaining."
 *
 * Contract:
 * - used = sum of entry.tokens for entries where
 *     (category === "data" || category === "logging") && fidelity === "promoted"
 * - budget = floor(contextSize * CEILING_RATIO) - baselineTokens
 * - remaining = max(0, budget - used)
 *
 * The model can predict the effect of promote/demote actions exactly:
 * promoting an entry adds entry.tokens to used; demoting subtracts it.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import ContextAssembler from "../../src/agent/ContextAssembler.js";
import KnownStore from "../../src/agent/KnownStore.js";
import { countTokens } from "../../src/agent/tokens.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

const CEILING_RATIO = Number(process.env.RUMMY_BUDGET_CEILING);

function pad(n) {
	return Array(n).fill("hello world test data").join(" ");
}

function parseProgressNumbers(userMessage) {
	const m = userMessage.match(
		/Token Budget: (\d+)\. Using (\d+)\. (\d+) remaining/,
	);
	if (!m) return null;
	return {
		used: Number(m[2]),
		budget: Number(m[1]),
		remaining: Number(m[3]),
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
		store = new KnownStore(tdb.db);
		await store.loadSchemes(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("used tokens", () => {
		it("used = 0 when no promoted controllable entries", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_used_zero" });
			await store.upsert(runId, 1, "prompt://1", "do thing", 200, {
				attributes: { mode: "ask" },
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const { messages } = await assemble(tdb, runId, 1);
			const nums = parseProgressNumbers(messages[1].content);
			assert.ok(nums, "progress numbers parsed");
			assert.strictEqual(nums.used, 0);
		});

		it("used equals tokens of single promoted known", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_used_one" });
			await store.upsert(runId, 1, "prompt://1", "do thing", 200, {
				attributes: { mode: "ask" },
			});
			const body = pad(50);
			await store.upsert(runId, 1, "known://fact", body, 200, {
				fidelity: "promoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const knownRow = rows.find((r) => r.path === "known://fact");
			const { messages } = await assemble(tdb, runId, 1);
			const nums = parseProgressNumbers(messages[1].content);
			assert.strictEqual(nums.used, knownRow.tokens);
		});

		it("used sums across multiple promoted entries", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_used_sum" });
			await store.upsert(runId, 1, "prompt://1", "do thing", 200, {
				attributes: { mode: "ask" },
			});
			await store.upsert(runId, 1, "known://a", pad(40), 200, {
				fidelity: "promoted",
			});
			await store.upsert(runId, 1, "known://b", pad(60), 200, {
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
			const nums = parseProgressNumbers(messages[1].content);
			assert.strictEqual(nums.used, expected);
		});

		it("demoted entries do not contribute to used", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_used_demoted" });
			await store.upsert(runId, 1, "prompt://1", "do thing", 200, {
				attributes: { mode: "ask" },
			});
			await store.upsert(runId, 1, "known://kept", pad(40), 200, {
				fidelity: "promoted",
			});
			await store.upsert(runId, 1, "known://hidden", pad(80), 200, {
				fidelity: "demoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const promotedTokens = rows.find((r) => r.path === "known://kept").tokens;
			const { messages } = await assemble(tdb, runId, 1);
			const nums = parseProgressNumbers(messages[1].content);
			assert.strictEqual(
				nums.used,
				promotedTokens,
				"demoted known excluded from used",
			);
		});

		it("prompt/unknown/system entries do not contribute to used", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_used_categories" });
			await store.upsert(runId, 1, "prompt://1", pad(20), 200, {
				attributes: { mode: "ask" },
			});
			await store.upsert(runId, 1, "unknown://gap", "what about X?", 200, {
				fidelity: "promoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const { messages } = await assemble(tdb, runId, 1);
			const nums = parseProgressNumbers(messages[1].content);
			assert.strictEqual(nums.used, 0, "no promoted data/logging → used = 0");
		});
	});

	describe("budget tokens", () => {
		it("budget = ceiling - baselineTokens", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_budget" });
			const contextSize = 32768;
			const ceiling = Math.floor(contextSize * CEILING_RATIO);
			await store.upsert(runId, 1, "prompt://1", "do thing", 200, {
				attributes: { mode: "ask" },
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const { messages, baselineTokens } = await assemble(
				tdb,
				runId,
				1,
				contextSize,
			);
			const nums = parseProgressNumbers(messages[1].content);
			assert.strictEqual(nums.budget, Math.max(0, ceiling - baselineTokens));
		});
	});

	describe("remaining", () => {
		it("remaining = budget - used", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_remaining" });
			await store.upsert(runId, 1, "prompt://1", "do thing", 200, {
				attributes: { mode: "ask" },
			});
			await store.upsert(runId, 1, "known://a", pad(50), 200, {
				fidelity: "promoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });
			const { messages } = await assemble(tdb, runId, 1);
			const nums = parseProgressNumbers(messages[1].content);
			assert.strictEqual(nums.remaining, Math.max(0, nums.budget - nums.used));
		});
	});

	describe("model action causality", () => {
		it("promoting a demoted known increases used by exactly entry.tokens", async () => {
			const { runId } = await tdb.seedRun({ alias: "p_promote" });
			await store.upsert(runId, 1, "prompt://1", "do thing", 200, {
				attributes: { mode: "ask" },
			});
			await store.upsert(runId, 1, "known://x", pad(75), 200, {
				fidelity: "demoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });

			const before = parseProgressNumbers(
				(await assemble(tdb, runId, 1)).messages[1].content,
			);
			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const entryTokens = rows.find((r) => r.path === "known://x").tokens;

			// Promote
			await store.setFidelity(runId, "known://x", "promoted");
			await materialize(tdb.db, { runId, turn: 2, systemPrompt: "sys" });

			const after = parseProgressNumbers(
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
			await store.upsert(runId, 1, "prompt://1", "do thing", 200, {
				attributes: { mode: "ask" },
			});
			await store.upsert(runId, 1, "known://y", pad(60), 200, {
				fidelity: "promoted",
			});
			await materialize(tdb.db, { runId, turn: 1, systemPrompt: "sys" });

			const before = parseProgressNumbers(
				(await assemble(tdb, runId, 1)).messages[1].content,
			);
			const rows = await tdb.db.get_turn_context.all({
				run_id: runId,
				turn: 1,
			});
			const entryTokens = rows.find((r) => r.path === "known://y").tokens;

			// Demote
			await store.setFidelity(runId, "known://y", "demoted");
			await materialize(tdb.db, { runId, turn: 2, systemPrompt: "sys" });

			const after = parseProgressNumbers(
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
