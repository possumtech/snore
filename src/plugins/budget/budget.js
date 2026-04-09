import { countTokens } from "../../agent/tokens.js";

/**
 * Budget plugin: guarantees materialized context fits within the model's
 * context window. The model owns its context management through
 * housekeeping prompts. The budget plugin is the backstop — measure,
 * warn, crash.
 *
 * No auto-crunch. No death spiral. No sidecar LLM calls.
 * The model compresses its own entries or the run fails.
 */

function measureMessages(messages) {
	return messages.reduce((sum, m) => sum + countTokens(m.content), 0);
}

export default class Budget {
	#core;

	constructor(core) {
		this.#core = core;
		core.hooks.budget = { enforce: this.enforce.bind(this) };
	}

	async enforce({
		contextSize,
		messages,
		rows,
	}) {
		if (!contextSize) return { messages, rows, demoted: [] };

		const ceiling = contextSize * 0.95;
		const assembledTokens = measureMessages(messages);

		console.warn(
			`[RUMMY] Budget enforce: ${assembledTokens} tokens, ceiling ${ceiling | 0} (contextSize ${contextSize}), ${rows.length} rows`,
		);

		if (assembledTokens > ceiling) {
			const floorBreakdown = rows
				.filter((r) => r.tokens > 0)
				.toSorted((a, b) => b.tokens - a.tokens)
				.slice(0, 10)
				.map((r) => `  ${r.path} (${r.fidelity}, ${r.tokens} tok)`)
				.join("\n");
			console.warn(
				`[RUMMY] Budget OVER: ${assembledTokens} tokens > ${ceiling | 0} ceiling\nLargest rows:\n${floorBreakdown}`,
			);
			throw new Error(
				`Context (${assembledTokens} tokens) exceeds model limit (${contextSize}). ` +
					"The model must use <set fidelity=\"summary\"/> or <rm/> to free space.",
			);
		}

		return { messages, rows, demoted: [] };
	}
}
