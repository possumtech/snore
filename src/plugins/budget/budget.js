import materializeContext from "../../agent/materializeContext.js";
import { countTokens } from "../../agent/tokens.js";

const CEILING_RATIO = Number(process.env.RUMMY_BUDGET_CEILING);
if (!CEILING_RATIO) throw new Error("RUMMY_BUDGET_CEILING must be set");

function measureMessages(messages) {
	return messages.reduce((sum, m) => sum + countTokens(m.content), 0);
}

export default class Budget {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({
			name: "budget",
			modelVisible: 1,
			category: "logging",
		});
		core.hooks.tools.onView("budget", (entry) => entry.body);
		core.hooks.budget = {
			enforce: this.enforce.bind(this),
			postDispatch: this.postDispatch.bind(this),
		};
	}

	#check({ contextSize, messages, rows, lastPromptTokens = 0 }) {
		const assembledTokens =
			lastPromptTokens > 0 ? lastPromptTokens : measureMessages(messages);
		const ceiling = Math.floor(contextSize * CEILING_RATIO);
		if (assembledTokens > ceiling) {
			return {
				messages,
				rows,
				assembledTokens,
				overflow: assembledTokens - ceiling,
				ok: false,
			};
		}
		return { messages, rows, assembledTokens, ok: true };
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
			await rummy.entries.setFidelity(ctx.runId, promptRow.path, "demoted");
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
		if (!contextSize) return;
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
		if (post.ok) return;

		const store = rummy.entries;
		const demotedEntries = await store.demoteTurnEntries(ctx.runId, ctx.turn);
		const promptRow = postMat.rows.find((r) => r.scheme === "prompt");
		if (promptRow) {
			await store.setFidelity(ctx.runId, promptRow.path, "demoted");
		}

		// NOTE: we do NOT rewrite get-result bodies or flip their state.
		// The get succeeded (state=resolved); budget demotion is a lifecycle
		// event, not a failure of the get. Body still reflects what was
		// true at the moment of the get; fidelity=demoted tells the model
		// the entry is no longer in the promoted view. The budget:// entry
		// is the canonical record of the panic. Model reads three consistent
		// signals: state=resolved (get worked), fidelity=demoted (it's out
		// of context now), budget://... (this turn overflowed).

		// The 50% rule is the key directive: it forces the model to sum
		// promotion costs (which is the behavior we want), and the threshold
		// gives a concrete ceiling for the next try. Twofer — abiding by the
		// rule requires budget awareness as a side effect.
		const ceiling = Math.floor(contextSize * CEILING_RATIO);
		const totalDemoted = demotedEntries.reduce((s, r) => s + r.tokens, 0);
		const body = [
			`Token Budget overflow: exceeded by ${post.overflow} tokens. Token Budget: ${ceiling}.`,
			`Your ${demotedEntries.length} promotions from last turn (${totalDemoted} tokens total) were demoted to fit.`,
			`Required: sum the tokens="N" of your promotions and new entries before emitting. A single turn must add no more than 50% of remaining Token Budget.`,
		].join("\n");

		await store.upsert(
			ctx.runId,
			ctx.turn,
			`budget://${ctx.loopId}/${ctx.turn}`,
			body,
			"failed",
			{ outcome: `overflow:${post.overflow}`, loopId: ctx.loopId },
		);
	}
}
