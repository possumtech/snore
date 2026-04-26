import { ceiling, computeBudget, measureMessages } from "../../agent/budget.js";
import materializeContext from "../../agent/materializeContext.js";
import { countTokens } from "../../agent/tokens.js";

/**
 * Delta-from-actual baseline. The pre-call <prompt tokenUsage> reports
 * the prior turn's actual API prompt_tokens; post-dispatch predicts
 * next turn's packet = this turn's actual tokens + tokens of new rows
 * written this turn. Keeps the 413 body on the same scale as the
 * model's <prompt> arithmetic — a 60% divergence between pre-call
 * (actual) and post-check (conservative estimator) makes the model
 * dismiss the system as janky and stop following rules.
 */
function predictNextPacket(rows, currentTurn, baseline) {
	let delta = 0;
	for (const r of rows) {
		if (r.source_turn === currentTurn) delta += countTokens(r.body);
	}
	return baseline + delta;
}

/**
 * Format the 413 error body. Names each demoted path with its turn
 * and token count so the model can avoid re-promoting them next turn.
 * Exported (not private) so unit tests can assert the exact wire
 * format — the model reads this string, so its shape is part of the
 * contract.
 */
export function overflowBody(overflow, contextSize, demoted) {
	const cap = ceiling(contextSize);
	const size = cap + overflow;
	const count = demoted.length;
	const totalTokens = demoted.reduce((s, r) => s + r.tokens, 0);
	const head = `Token Budget overflow: packet was ${size} tokens, ceiling is ${cap}. ${count} promotion${count === 1 ? "" : "s"} (${totalTokens} tokens) demoted to fit.`;
	if (count === 0) return head;
	const lines = demoted.map((d) =>
		d.turn
			? `- ${d.path} (turn ${d.turn}, ${d.tokens} tokens)`
			: `- ${d.path} (${d.tokens} tokens)`,
	);
	return `${head}\nDemoted:\n${lines.join("\n")}`;
}

export default class Budget {
	#core;

	constructor(core) {
		this.#core = core;
		core.hooks.budget = {
			enforce: this.enforce.bind(this),
			postDispatch: this.postDispatch.bind(this),
		};
		core.filter("assembly.user", this.assembleBudget.bind(this), 275);
	}

	/**
	 * Render the <budget> table between <instructions> and <prompt>.
	 * See SPEC @token_accounting for the contract: per-row tokens are
	 * aTokens (the promotion premium = vTokens − sTokens), summarized
	 * entries collapse into a single aggregate line, system overhead
	 * (system prompt + tool defs) gets its own line.
	 */
	assembleBudget(content, ctx) {
		const { rows, contextSize, systemPrompt } = ctx;
		if (!contextSize) return content;

		const cap = ceiling(contextSize);

		const visibleByScheme = new Map();
		let visibleCount = 0;
		let premiumTokens = 0;
		let summarizedCount = 0;
		let summarizedTokens = 0;
		let floorTokens = 0;
		let knownVTokens = 0;
		let sourceVTokens = 0;

		for (const r of rows) {
			if (r.aTokens == null) continue;
			const s = r.scheme || "file";
			if (r.visibility === "visible") {
				const entry = visibleByScheme.get(s) ?? { count: 0, tokens: 0 };
				entry.count += 1;
				entry.tokens += r.aTokens;
				visibleByScheme.set(s, entry);
				visibleCount += 1;
				premiumTokens += r.aTokens;
				floorTokens += r.sTokens;
				const v = r.vTokens || 0;
				if (s === "known") knownVTokens += v;
				else if (s === "prompt") sourceVTokens += v;
				else if (r.category === "data") sourceVTokens += v;
			} else if (r.visibility === "summarized") {
				summarizedCount += 1;
				summarizedTokens += r.sTokens;
				floorTokens += r.sTokens;
			}
		}

		const fcrmDenom = knownVTokens + sourceVTokens;
		const fcrmScore =
			fcrmDenom > 0 ? (knownVTokens / fcrmDenom).toFixed(2) : "1.00";

		const systemTokens = countTokens(systemPrompt || "");
		const tokenUsage = floorTokens + premiumTokens + systemTokens;
		const tokensFree = Math.max(0, cap - tokenUsage);

		const schemeRows = [...visibleByScheme.entries()]
			.toSorted((a, b) => b[1].tokens - a[1].tokens)
			.map(([scheme, v]) => {
				const pct = Math.round((v.tokens / cap) * 100);
				return `| ${scheme} | ${v.count} | ${v.tokens} | ${pct}% |`;
			});

		const summarizedPct = Math.round((summarizedTokens / cap) * 100);
		const systemPct = Math.round((systemTokens / cap) * 100);

		const table = [
			"| scheme | visible | tokens | % |",
			"|---|---|---|---|",
			...schemeRows,
		].join("\n");

		const summarizedLine = `Summarized: ${summarizedCount} entries, ${summarizedTokens} tokens (${summarizedPct}% of budget).`;
		const systemLine = `System: ${systemTokens} tokens (${systemPct}% of budget).`;
		const totalLine = `Total: ${visibleCount} visible + ${summarizedCount} summarized entries; tokenUsage ${tokenUsage} / ceiling ${cap}. ${tokensFree} tokens free.`;

		return `${content}<budget tokenUsage="${tokenUsage}" tokensFree="${tokensFree}" fcrmScore="${fcrmScore}">\n${table}\n\n${summarizedLine}\n${systemLine}\n${totalLine}\n</budget>\n`;
	}

	#check({ contextSize, messages, rows, lastPromptTokens = 0 }) {
		const totalTokens =
			lastPromptTokens > 0 ? lastPromptTokens : measureMessages(messages);
		const b = computeBudget({ rows, contextSize, totalTokens });
		return {
			messages,
			rows,
			assembledTokens: b.totalTokens,
			overflow: b.overflow,
			ok: b.ok,
		};
	}

	async #emitOverflow({
		message,
		runId,
		turn,
		loopId,
		rummy,
		demotedCount = 0,
		demotedTokens = 0,
	}) {
		await rummy.hooks.error.log.emit({
			store: rummy.entries,
			runId,
			turn,
			loopId,
			message,
			status: 413,
			attributes: { demotedCount, demotedTokens },
		});
	}

	/**
	 * Pre-LLM budget enforcement. On first-turn overflow, demotes the
	 * incoming prompt and re-materializes; re-checks and returns the
	 * post-demotion result. If overflow persists after demotion (or on
	 * later iterations), emits a 413 error (strike) and returns !ok so
	 * TurnExecutor can skip the LLM call this turn.
	 *
	 * ctx = { runId, loopId, turn, systemPrompt, mode, toolSet, demoted,
	 *         loopIteration }
	 */
	async enforce({
		contextSize,
		messages,
		rows,
		lastPromptTokens = 0,
		ctx,
		rummy,
	}) {
		if (!contextSize) {
			return { messages, rows, assembledTokens: 0, ok: true };
		}

		const first = this.#check({
			contextSize,
			messages,
			rows,
			lastPromptTokens,
		});
		if (first.ok) return first;

		if (ctx?.loopIteration !== 1) {
			const cap = ceiling(contextSize);
			await this.#emitOverflow({
				message: `Token Budget overflow: packet was ${cap + first.overflow} tokens, ceiling is ${cap}.`,
				runId: ctx.runId,
				turn: ctx.turn,
				loopId: ctx.loopId,
				rummy,
			});
			return first;
		}

		const promptRow = rows.findLast(
			(r) => r.category === "prompt" && r.scheme === "prompt",
		);
		if (promptRow) {
			await rummy.entries.set({
				runId: ctx.runId,
				path: promptRow.path,
				visibility: "summarized",
			});
		}
		const reMat = await materializeContext({
			db: rummy.db,
			hooks: rummy.hooks,
			runId: ctx.runId,
			loopId: ctx.loopId,
			turn: ctx.turn,
			systemPrompt: ctx.systemPrompt,
			mode: ctx.mode,
			toolSet: ctx.toolSet,
			contextSize,
			demoted: ctx.demoted,
		});
		const rechecked = this.#check({
			contextSize,
			messages: reMat.messages,
			rows: reMat.rows,
			lastPromptTokens: reMat.lastContextTokens,
		});
		if (!rechecked.ok) {
			const cap = ceiling(contextSize);
			await this.#emitOverflow({
				message: `Token Budget overflow: packet was ${cap + rechecked.overflow} tokens after demoting the prompt, ceiling is ${cap}.`,
				runId: ctx.runId,
				turn: ctx.turn,
				loopId: ctx.loopId,
				rummy,
			});
		}
		return rechecked;
	}

	/**
	 * Post-dispatch Turn Demotion. Re-materializes end-of-turn context and
	 * checks against the ceiling. On overflow, demotes this turn's promoted
	 * entries and emits a 413 error (strike) with the descriptive body so
	 * the model sees it next turn via the unified error channel.
	 *
	 * ctx = { runId, loopId, turn, systemPrompt, mode, toolSet, demoted }
	 */
	async postDispatch({ contextSize, ctx, rummy }) {
		if (!contextSize) return { failed: false };
		const postMat = await materializeContext({
			db: rummy.db,
			hooks: rummy.hooks,
			runId: ctx.runId,
			loopId: ctx.loopId,
			turn: ctx.turn,
			systemPrompt: ctx.systemPrompt,
			mode: ctx.mode,
			toolSet: ctx.toolSet,
			contextSize,
			demoted: ctx.demoted,
		});
		// Baseline from this turn's actual API tokens (telemetry wrote it
		// before post-dispatch runs). Delta from rows added this turn.
		// Predicted next-turn packet stays on the tokenUsage scale the
		// model can verify against its own arithmetic. materializeContext
		// guarantees a number (0 when no prior API call exists).
		const baseline = postMat.lastContextTokens;
		const predicted = predictNextPacket(postMat.rows, ctx.turn, baseline);
		const cap = ceiling(contextSize);
		if (predicted <= cap) return { failed: false };
		const post = { overflow: predicted - cap };

		const store = rummy.entries;
		let demotedEntries = await store.demoteTurnEntries(ctx.runId, ctx.turn);
		// Fallback: if this turn had nothing to demote but the packet still
		// overflows, the pressure is coming from prior-turn promotions the
		// model never demoted itself. Widen to all currently-visible
		// entries in the run. Without this fallback, overflow-with-nothing
		// strikes out runs where the base context has drifted over ceiling
		// through no fault of the current turn (observed: runs where 3
		// stale promotions from turns 12–14 saturate every subsequent
		// turn's budget).
		if (demotedEntries.length === 0) {
			demotedEntries = await store.demoteRunVisibleEntries(ctx.runId);
		}
		const promptRow = postMat.rows.find((r) => r.scheme === "prompt");
		if (promptRow) {
			await store.set({
				runId: ctx.runId,
				path: promptRow.path,
				visibility: "summarized",
			});
		}

		const totalDemoted = demotedEntries.reduce((s, r) => s + r.tokens, 0);
		await this.#emitOverflow({
			message: overflowBody(post.overflow, contextSize, demotedEntries),
			demotedCount: demotedEntries.length,
			demotedTokens: totalDemoted,
			runId: ctx.runId,
			turn: ctx.turn,
			loopId: ctx.loopId,
			rummy,
		});
		return { failed: true };
	}
}
