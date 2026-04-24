import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ceiling } from "../../agent/budget.js";
import Budget, { overflowBody } from "./budget.js";

describe("Budget", () => {
	it("enforce returns ok when under budget", async () => {
		const budget = new Budget({
			hooks: { budget: null, tools: { onView: () => {} } },
			registerScheme: () => {},
		});
		const result = await budget.enforce({
			contextSize: 10000,
			messages: [{ role: "system", content: "short" }],
			rows: [],
		});
		assert.strictEqual(result.ok, true);
		assert.ok(result.assembledTokens > 0);
	});

	it("enforce returns overflow when over budget", async () => {
		const budget = new Budget({
			hooks: { budget: null, tools: { onView: () => {} } },
			registerScheme: () => {},
		});
		const result = await budget.enforce({
			contextSize: 10,
			messages: [{ role: "system", content: "x".repeat(1000) }],
			rows: [],
			ctx: { runId: 1, turn: 1, loopId: 0, loopIteration: 0 },
			rummy: {
				hooks: { error: { log: { emit: async () => {} } } },
			},
		});
		assert.strictEqual(result.ok, false);
		assert.ok(result.overflow > 0);
	});

	it("enforce returns ok with no contextSize", async () => {
		const budget = new Budget({
			hooks: { budget: null, tools: { onView: () => {} } },
			registerScheme: () => {},
		});
		const result = await budget.enforce({
			contextSize: null,
			messages: [{ role: "system", content: "anything" }],
			rows: [],
		});
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.assembledTokens, 0);
	});
});

// The 413 body is what the model reads. When it doesn't name the
// demoted paths, the model re-promotes the same entries next turn and
// the loop cycles (observed: same Wikipedia URL promoted 9 times in
// rummy_dev.db::test:demo). This is the contract.
describe("overflowBody — 413 error body shape", () => {
	const contextSize = 10000;
	const cap = ceiling(contextSize); // depends on RUMMY_BUDGET_CEILING

	it("0 demoted: header only, no Demoted: section", () => {
		const body = overflowBody(500, contextSize, []);
		assert.ok(body.startsWith("Token Budget overflow:"));
		assert.ok(
			body.includes("0 promotions (0 tokens) demoted to fit."),
			`header mentions 0 promotions; got: ${body}`,
		);
		assert.ok(
			!body.includes("Demoted:"),
			"no Demoted: section when nothing was demoted",
		);
	});

	it("1 demoted: singular 'promotion', path named with turn and tokens", () => {
		const body = overflowBody(500, contextSize, [
			{ path: "https://example.com/wiki/X", tokens: 4418, turn: 7 },
		]);
		assert.ok(
			body.includes("1 promotion (4418 tokens) demoted to fit."),
			`singular grammar; got: ${body}`,
		);
		assert.ok(body.includes("Demoted:"));
		assert.ok(
			body.includes("- https://example.com/wiki/X (turn 7, 4418 tokens)"),
			`path named with turn and tokens; got:\n${body}`,
		);
	});

	it("N demoted: plural 'promotions', each path named, token sum correct", () => {
		const body = overflowBody(2753, contextSize, [
			{ path: "https://a.example/one", tokens: 1200, turn: 3 },
			{ path: "https://b.example/two", tokens: 900, turn: 5 },
			{ path: "known://fact", tokens: 250, turn: 6 },
		]);
		assert.ok(
			body.includes("3 promotions (2350 tokens) demoted to fit."),
			`plural + sum; got: ${body}`,
		);
		assert.ok(body.includes("- https://a.example/one (turn 3, 1200 tokens)"));
		assert.ok(body.includes("- https://b.example/two (turn 5, 900 tokens)"));
		assert.ok(body.includes("- known://fact (turn 6, 250 tokens)"));
	});

	it("ordering: lines appear in the order the caller provides (oldest first)", () => {
		// demoteRunVisibleEntries returns rows ordered by turn ASC so the
		// error body reads oldest-first, matching the model's reading
		// order when it scans the log.
		const body = overflowBody(500, contextSize, [
			{ path: "old", tokens: 100, turn: 3 },
			{ path: "mid", tokens: 100, turn: 7 },
			{ path: "new", tokens: 100, turn: 14 },
		]);
		const oldIdx = body.indexOf("- old");
		const midIdx = body.indexOf("- mid");
		const newIdx = body.indexOf("- new");
		assert.ok(
			oldIdx < midIdx && midIdx < newIdx,
			"oldest-first ordering preserved",
		);
	});

	it("packet size reported = ceiling + overflow", () => {
		const overflow = 2753;
		const body = overflowBody(overflow, contextSize, []);
		assert.ok(
			body.includes(`packet was ${cap + overflow} tokens`),
			`packet = ceiling + overflow (${cap} + ${overflow}); got: ${body}`,
		);
		assert.ok(body.includes(`ceiling is ${cap}`));
	});

	it("regression: named paths let the model avoid the 9-retry loop", () => {
		// Original bug: turns 3–12 in rummy_dev.db::test:demo all tried
		// to promote the same Wikipedia URL because the 413 body said
		// "N promotions demoted" without naming them. Next turn the
		// model saw the page summarized, re-promoted, re-demoted.
		const body = overflowBody(500, contextSize, [
			{
				path: "https://en.wikipedia.org/wiki/White_River_(Indiana)",
				tokens: 17744,
				turn: 3,
			},
		]);
		assert.ok(
			body.includes("https://en.wikipedia.org/wiki/White_River_(Indiana)"),
			"model can now see which URL got demoted",
		);
	});
});
