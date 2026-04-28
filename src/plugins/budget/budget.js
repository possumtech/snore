import { ceiling, computeBudget, measureMessages } from "../../agent/budget.js";
import materializeContext from "../../agent/materializeContext.js";
import { countTokens } from "../../agent/tokens.js";

// Delta-from-actual; same scale as <prompt tokenUsage>. SPEC #budget_enforcement.
function predictNextPacket(rows, currentTurn, baseline) {
	let delta = 0;
	for (const r of rows) {
		if (r.source_turn === currentTurn) delta += countTokens(r.body);
	}
	return baseline + delta;
}

// 413 error body; wire format is part of the model contract.
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

	// Renders <budget> at priority 275; see SPEC #token_accounting.
	assembleBudget(content, ctx) {
		const { rows, contextSize, systemPrompt } = ctx;
		if (!contextSize) return content;

		const cap = ceiling(contextSize);

		const byScheme = new Map();
		let visibleCount = 0;
		let premiumTokens = 0;
		let summarizedCount = 0;
		let _summarizedTokens = 0;
		let floorTokens = 0;

		const schemeEntry = (s) => {
			let e = byScheme.get(s);
			if (!e) {
				e = {
					vis: 0,
					sum: 0,
					visTokens: 0, // current cost of visible entries
					visIfSumTokens: 0, // sTokens of visible (what they'd cost demoted)
					sumTokens: 0, // current cost of summarized entries
					premium: 0, // savings from demoting visible → summarized
				};
				byScheme.set(s, e);
			}
			return e;
		};

		for (const r of rows) {
			if (r.aTokens == null) continue;
			const s = r.scheme || "file";
			const entry = schemeEntry(s);
			if (r.visibility === "visible") {
				entry.vis += 1;
				entry.visTokens += r.vTokens || 0;
				entry.visIfSumTokens += r.sTokens || 0;
				entry.premium += r.aTokens || 0;
				visibleCount += 1;
				premiumTokens += r.aTokens;
				floorTokens += r.sTokens;
			} else if (r.visibility === "summarized") {
				entry.sum += 1;
				entry.sumTokens += r.sTokens || 0;
				summarizedCount += 1;
				_summarizedTokens += r.sTokens;
				floorTokens += r.sTokens;
			}
		}

		const systemTokens = countTokens(systemPrompt || "");
		const tokenUsage = floorTokens + premiumTokens + systemTokens;
		const tokensFree = Math.max(0, cap - tokenUsage);

		// Sort by current cost desc so biggest-impact rows are top.
		const schemeRows = [...byScheme.entries()]
			.toSorted(
				([, a], [, b]) =>
					b.visTokens + b.sumTokens - (a.visTokens + a.sumTokens),
			)
			.map(([scheme, e]) => {
				const cost = e.visTokens + e.sumTokens;
				const ifAllSum = e.visIfSumTokens + e.sumTokens;
				return `| ${scheme} | ${e.vis} | ${e.sum} | ${cost} | ${ifAllSum} | ${e.premium} |`;
			});

		const systemPct =
			tokenUsage > 0 ? Math.round((systemTokens / tokenUsage) * 100) : 0;

		const table = [
			"| scheme | vis | sum | cost | if-all-sum | premium |",
			"|---|---|---|---|---|---|",
			...schemeRows,
		].join("\n");

		const systemLine = `System: ${systemTokens} tokens (${systemPct}% of budget).`;
		const totalLine = `Total: ${visibleCount} visible + ${summarizedCount} summarized entries; tokenUsage ${tokenUsage} / ceiling ${cap}. ${tokensFree} tokens free.`;
		const legend = [
			"Columns:",
			"- cost: current cost of this scheme (vTokens for visible + sTokens for summarized)",
			"- if-all-sum: cost if every entry of this scheme were demoted to summarized",
			"- premium: savings from demoting visible → summarized (cost − if-all-sum)",
		].join("\n");

		return `${content}<budget tokenUsage="${tokenUsage}" tokensFree="${tokensFree}">\n${table}\n\n${legend}\n${systemLine}\n${totalLine}\n</budget>\n`;
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

	// Pre-LLM enforce: SPEC #budget_enforcement.
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

	// Post-dispatch Turn Demotion: SPEC #budget_enforcement.
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
		const baseline = postMat.lastContextTokens;
		const predicted = predictNextPacket(postMat.rows, ctx.turn, baseline);
		const cap = ceiling(contextSize);
		if (predicted <= cap) return { failed: false };
		const post = { overflow: predicted - cap };

		const store = rummy.entries;
		let demotedEntries = await store.demoteTurnEntries(ctx.runId, ctx.turn);
		// Prior-turn-pressure fallback; SPEC #budget_enforcement.
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
