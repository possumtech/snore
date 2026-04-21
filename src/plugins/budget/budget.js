import { ceiling, computeBudget, measureMessages } from "../../agent/budget.js";
import materializeContext from "../../agent/materializeContext.js";

export default class Budget {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({
			name: "budget",
			modelVisible: 1,
			category: "logging",
		});
		core.hooks.tools.onView("budget", (entry) => entry.body, "visible");
		core.hooks.tools.onView("budget", (entry) => entry.body, "summarized");
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

	/**
	 * Pre-LLM budget enforcement. On first-turn overflow, demotes the
	 * incoming prompt and re-materializes; re-checks and returns the
	 * post-demotion result. On non-first-turn overflow, returns 413 so
	 * TurnExecutor can exit the loop.
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
		if (ctx?.loopIteration !== 1) return first;

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
		return this.#check({
			contextSize,
			messages: reMat.messages,
			rows: reMat.rows,
			lastPromptTokens: reMat.lastContextTokens,
		});
	}

	/**
	 * Post-dispatch Turn Demotion. Re-materializes end-of-turn context and
	 * checks against the ceiling. On overflow, demotes this turn's promoted
	 * entries and writes a budget:// entry. No return value — the model
	 * reads the budget:// entry next turn.
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

		// NOTE: we do NOT rewrite get-result bodies or flip their state.
		// The get succeeded (state=resolved); budget demotion is a lifecycle
		// event, not a failure of the get. Body still reflects what was
		// true at the moment of the get; visibility=demoted tells the model
		// the entry is no longer in the promoted view. The budget:// entry
		// is the canonical record of the panic. Model reads three consistent
		// signals: state=resolved (get worked), visibility=demoted (it's out
		// of context now), budget://... (this turn overflowed).

		// The 50% rule is the key directive: it forces the model to sum
		// promotion costs (which is the behavior we want), and the threshold
		// gives a concrete ceiling for the next try. Twofer — abiding by the
		// rule requires budget awareness as a side effect.
		const totalDemoted = demotedEntries.reduce((s, r) => s + r.tokens, 0);
		const body = [
			`Token Budget overflow: exceeded by ${post.overflow} tokens. Ceiling: ${ceiling(contextSize)}.`,
			`Your ${demotedEntries.length} promotions from last turn (${totalDemoted} tokens total) were demoted to fit.`,
			`Required: sum the tokens="N" of your promotions and new entries before emitting. A single turn must add no more than 50% of remaining Token Budget.`,
		].join("\n");

		await store.set({
			runId: ctx.runId,
			turn: ctx.turn,
			path: `budget://${ctx.loopId}/${ctx.turn}`,
			body,
			state: "failed",
			outcome: `overflow:${post.overflow}`,
			loopId: ctx.loopId,
		});
		return { failed: true };
	}
}
