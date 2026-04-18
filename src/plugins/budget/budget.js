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
				status: 413,
				overflow: assembledTokens - ceiling,
			};
		}
		return { messages, rows, assembledTokens, status: 200 };
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
	async enforce({ contextSize, messages, rows, lastPromptTokens = 0, ctx }) {
		if (!contextSize) {
			return { messages, rows, assembledTokens: 0, status: 200 };
		}

		const first = this.#check({
			contextSize,
			messages,
			rows,
			lastPromptTokens,
		});
		if (first.status !== 413) return first;
		if (ctx?.loopIteration !== 1) return first;

		const promptRow = rows.findLast(
			(r) => r.category === "prompt" && r.scheme === "prompt",
		);
		if (promptRow) {
			await this.#core.entries.setFidelity(
				ctx.runId,
				promptRow.path,
				"demoted",
			);
		}
		const reMat = await materializeContext({
			db: this.#core.db,
			hooks: this.#core.hooks,
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
	async postDispatch({ contextSize, ctx }) {
		if (!contextSize) return;
		const postMat = await materializeContext({
			db: this.#core.db,
			hooks: this.#core.hooks,
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
		if (post.status !== 413) return;

		const store = this.#core.entries;
		const demotedEntries = await store.demoteTurnEntries(ctx.runId, ctx.turn);
		const promptRow = postMat.rows.find((r) => r.scheme === "prompt");
		if (promptRow) {
			await store.setFidelity(ctx.runId, promptRow.path, "demoted");
		}

		// NOTE: we do NOT rewrite get-result bodies or flip their status.
		// The get succeeded (status=200); budget demotion is a lifecycle
		// event, not a failure of the get. The body still says "promoted"
		// (which was true at the moment of the get); fidelity=demoted tells
		// the model the entry is no longer in the promoted view. The budget://
		// entry is the canonical record of the panic. Model reads three
		// consistent signals: status=200 (get worked), fidelity=demoted (it's
		// out of context now), budget://... (this turn overflowed).

		// The 50% rule is the key directive: it forces the model to sum
		// promotion costs (which is the behavior we want), and the threshold
		// gives a concrete ceiling for the next try. Twofer — abiding by the
		// rule requires budget awareness as a side effect.
		const ceiling = Math.floor(contextSize * CEILING_RATIO);
		const totalDemoted = demotedEntries.reduce((s, r) => s + r.tokens, 0);
		const body = [
			`413 Token Budget Error: overflowed by ${post.overflow} tokens. Token Budget: ${ceiling}.`,
			`Your ${demotedEntries.length} promotions from last turn (${totalDemoted} tokens total) were demoted to fit.`,
			`Required: sum the tokens="N" of your promotions and new entries before emitting. A single turn must add no more than 50% of remaining Token Budget.`,
		].join("\n");

		await store.upsert(
			ctx.runId,
			ctx.turn,
			`budget://${ctx.loopId}/${ctx.turn}`,
			body,
			413,
			{ loopId: ctx.loopId },
		);
	}
}
