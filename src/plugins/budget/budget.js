import { ceiling, computeBudget, measureMessages } from "../../agent/budget.js";
import materializeContext from "../../agent/materializeContext.js";

export default class Budget {
	#core;

	constructor(core) {
		this.#core = core;
		core.hooks.budget = {
			enforce: this.enforce.bind(this),
			postDispatch: this.postDispatch.bind(this),
		};
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

	#overflowBody(overflow, contextSize, demotedCount, demotedTokens) {
		const cap = ceiling(contextSize);
		const size = cap + overflow;
		return `Token Budget overflow: packet was ${size} tokens, ceiling is ${cap}. ${demotedCount} promotion${demotedCount === 1 ? "" : "s"} (${demotedTokens} tokens) demoted to fit.`;
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
		const post = this.#check({
			contextSize,
			messages: postMat.messages,
			rows: postMat.rows,
		});
		if (post.ok) return { failed: false };

		const store = rummy.entries;
		const demotedEntries = await store.demoteTurnEntries(ctx.runId, ctx.turn);
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
			message: this.#overflowBody(
				post.overflow,
				contextSize,
				demotedEntries.length,
				totalDemoted,
			),
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
