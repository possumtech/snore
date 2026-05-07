/**
 * log plugin: tokens= invariant.
 *
 * The `tokens=` attr on every tag rendered inside <log> must always
 * equal the full-visibility cost of the thing the tag represents —
 * NEVER the log entry's own stub body size. A past regression reported
 * `<get tokens="30">` for a URL whose real body was 4418 tokens (the
 * log body was just "URL promoted"), letting the model promote three
 * pages totaling 8882 tokens thinking they cost ~100 total.
 *
 * The rule:
 * - If attrs.path resolves to a data entry in ctx.rows → tokens=target.tokens.
 * - Else if the action is sh/env (multi-channel) → omit tokens entirely.
 * - Else → tokens=entry.tokens (log body is the cost-bearing content).
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import Log from "./log.js";

function makeHooks() {
	const hooks = createHooks();
	const core = new PluginContext("log", hooks);
	new Log(core);
	return hooks;
}

function logRow({
	turn = 1,
	action,
	slug,
	body = "",
	tokens = 0,
	state = "resolved",
	outcome = null,
	attrs = {},
}) {
	return {
		ordinal: 0,
		path: `log://turn_${turn}/${action}/${slug}`,
		scheme: "log",
		visibility: "visible",
		state,
		outcome,
		body,
		vTokens: tokens,
		sTokens: 0,
		aTokens: tokens,
		attributes: JSON.stringify({ action, ...attrs }),
		category: "logging",
		source_turn: turn,
	};
}

function dataRow({ path, scheme, tokens, body = "", category = "data" }) {
	return {
		ordinal: 0,
		path,
		scheme,
		visibility: "visible",
		state: "resolved",
		body,
		vTokens: tokens,
		sTokens: 0,
		aTokens: tokens,
		attributes: null,
		category,
		source_turn: 1,
	};
}

async function render(rows) {
	const hooks = makeHooks();
	const out = await hooks.assembly.user.filter("", { rows });
	return out;
}

describe("log plugin tokens= invariant", () => {
	it("<get> tokens= reports target's full tokens, not log stub tokens", async () => {
		const target = dataRow({
			path: "https://example.com/page",
			scheme: "https",
			tokens: 4418,
		});
		const getLog = logRow({
			action: "get",
			slug: "https%3A//example.com/page",
			body: "https://example.com/page promoted",
			tokens: 30,
			attrs: { path: "https://example.com/page" },
		});
		const out = await render([target, getLog]);
		assert.match(
			out,
			/"action":"get"[^}]*"tokens":4418/,
			"tokens is target size",
		);
		assert.doesNotMatch(
			out,
			/"action":"get"[^}]*"tokens":30/,
			"stub size not leaked",
		);
	});

	it("<set> tokens= reports target's full tokens (e.g. the known:// entry)", async () => {
		const target = dataRow({
			path: "known://fact",
			scheme: "known",
			tokens: 250,
		});
		const setLog = logRow({
			action: "set",
			slug: "known%3A//fact",
			body: "The body of the fact…",
			tokens: 40,
			attrs: { path: "known://fact" },
		});
		const out = await render([target, setLog]);
		assert.match(
			out,
			/"action":"set"[^}]*"tokens":250/,
			"tokens is target size",
		);
	});

	it("<get> falls back to entry.tokens when target is absent (rm'd or never loaded)", async () => {
		const getLog = logRow({
			action: "get",
			slug: "missing",
			body: "not found",
			tokens: 5,
			attrs: { path: "gone://nowhere" },
		});
		const out = await render([getLog]);
		assert.match(
			out,
			/"action":"get"[^}]*"tokens":5/,
			"falls back to log body tokens",
		);
	});

	it("<search> tokens= is the log body tokens (results listing)", async () => {
		const searchLog = logRow({
			action: "search",
			slug: "query",
			body: "6 results...\nurl1\nurl2\n",
			tokens: 204,
			attrs: { query: "query" },
		});
		const out = await render([searchLog]);
		assert.match(out, /"action":"search"[^}]*"tokens":204/);
	});

	it("<update> tokens= is the log body tokens", async () => {
		const updateLog = logRow({
			action: "update",
			slug: "done",
			body: "Fixed it",
			tokens: 8,
			attrs: { status: 200 },
		});
		const out = await render([updateLog]);
		assert.match(out, /"action":"update"[^}]*"tokens":8/);
	});

	it("<error> tokens= is the log body tokens (the error message)", async () => {
		const errLog = logRow({
			action: "error",
			slug: "overflow",
			body: "Token Budget overflow: packet was 40623 tokens...",
			tokens: 54,
			attrs: { status: 413 },
			state: "failed",
			outcome: "status:413",
		});
		const out = await render([errLog]);
		assert.match(out, /"action":"error"[^}]*"tokens":54/);
	});

	it("<sh> omits tokens= entirely — no stub tokens can leak", async () => {
		const shLog = logRow({
			action: "sh",
			slug: "echo",
			body: "ran 'echo hi', exit=0. Output: sh://turn_1/echo_1 (40 tokens), sh://turn_1/echo_2 (empty)",
			tokens: 35,
			attrs: { command: "echo hi" },
		});
		const out = await render([shLog]);
		assert.match(out, /"action":"sh"/);
		assert.doesNotMatch(
			out,
			/"action":"sh"[^}]*"tokens":/,
			"sh never shows tokens",
		);
	});

	it("<env> omits tokens= entirely", async () => {
		const envLog = logRow({
			action: "env",
			slug: "pwd",
			body: "ran 'pwd', exit=0. Output: env://turn_1/pwd_1 (3 tokens), env://turn_1/pwd_2 (empty)",
			tokens: 30,
			attrs: { command: "pwd" },
		});
		const out = await render([envLog]);
		assert.match(out, /"action":"env"/);
		assert.doesNotMatch(out, /"action":"env"[^}]*"tokens":/);
	});

	it("<get> slice render: lines= attr and slice tokens (not target tokens)", async () => {
		// Partial-read <get line=.. limit=..> writes slice content into the
		// log entry body and tags lineStart/lineEnd/totalLines on attrs.
		// The rendered tag must:
		//   - surface `lines="a-b/total"` so the model sees the range
		//   - report tokens= of the SLICE body, not the full target
		// Otherwise a 19k-token URL with a 200-token slice log would be
		// mispriced 100x and the model would over- or under-demote.
		const target = dataRow({
			path: "https://example.com/page",
			scheme: "https",
			tokens: 19500,
		});
		const sliceLog = logRow({
			action: "get",
			slug: "https%3A//example.com/page",
			body: "https://example.com/page\n[lines 1–50 / 262 total]\n…slice…",
			tokens: 200,
			attrs: {
				path: "https://example.com/page",
				lineStart: 1,
				lineEnd: 50,
				totalLines: 262,
			},
		});
		const out = await render([target, sliceLog]);
		assert.match(
			out,
			/"action":"get"[^}]*"lines":"1-50\/262"/,
			"lines attr present",
		);
		assert.match(
			out,
			/"action":"get"[^}]*"tokens":200/,
			"slice tokens, not target",
		);
		assert.doesNotMatch(
			out,
			/"action":"get"[^}]*"tokens":19500/,
			"target size not leaked on slice log",
		);
	});

	it("regression: 3 <get> promotions reporting target tokens match 413 demoted figure", async () => {
		const pages = [
			dataRow({
				path: "https://en.wikipedia.org/wiki/Lost_River",
				scheme: "https",
				tokens: 4418,
			}),
			dataRow({
				path: "https://en.wikipedia.org/wiki/Patoka_Lake",
				scheme: "https",
				tokens: 3298,
			}),
			dataRow({
				path: "https://example.com/wmp",
				scheme: "https",
				tokens: 1166,
			}),
		];
		const logs = pages.map((p) =>
			logRow({
				action: "get",
				slug: encodeURIComponent(p.path),
				body: `${p.path} promoted`,
				tokens: 30,
				attrs: { path: p.path },
			}),
		);
		const out = await render([...pages, ...logs]);
		const matches = [...out.matchAll(/"action":"get"[^}]*"tokens":(\d+)/g)].map(
			(m) => Number(m[1]),
		);
		assert.strictEqual(matches.length, 3, "three get tags rendered");
		const total = matches.reduce((a, b) => a + b, 0);
		assert.strictEqual(
			total,
			4418 + 3298 + 1166,
			"get tokens match target bodies (8882), not stub tokens (90)",
		);
	});
});
