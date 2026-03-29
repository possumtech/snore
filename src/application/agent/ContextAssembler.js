/**
 * Assembles the LLM messages array from the known store, summary log,
 * and unknown list. No message history — tool results ARE the context.
 *
 * Message structure:
 *   1. system — role description + constraints
 *   2. assistant (synthetic) — previous turn's tool calls
 *   3. tool results — known entries, unknown list, summary log
 *   4. user — current input
 */
export default class ContextAssembler {
	/**
	 * @param {object} opts
	 * @param {string} opts.systemPrompt
	 * @param {Array} opts.knownEntries - [{key, state, value}] model-facing projection
	 * @param {Array} opts.unknownList - string[] from previous turn
	 * @param {Array} opts.summaryLog - [{tool, target, status, key, value}]
	 * @param {string} opts.userMessage
	 * @returns {Array} messages array for the LLM API
	 */
	static assemble({ systemPrompt, knownEntries, unknownList, summaryLog, userMessage }) {
		const messages = [];

		// 1. System prompt
		if (systemPrompt) {
			messages.push({ role: "system", content: systemPrompt });
		}

		// 2-3. Synthetic previous turn (assistant tool calls + tool results)
		// The model needs to see tool_calls followed by matching tool results
		// to understand its own prior state.
		const syntheticCalls = [];
		const toolResults = [];

		// Known state
		syntheticCalls.push({
			id: "prev_known",
			type: "function",
			function: { name: "known", arguments: "{\"entries\":[]}" },
		});
		toolResults.push({
			role: "tool",
			tool_call_id: "prev_known",
			content: JSON.stringify(knownEntries),
		});

		// Summary log
		syntheticCalls.push({
			id: "prev_summary",
			type: "function",
			function: { name: "summary", arguments: "{\"text\":\"(prior state)\"}" },
		});
		toolResults.push({
			role: "tool",
			tool_call_id: "prev_summary",
			content: JSON.stringify(summaryLog),
		});

		// Unknown list (only if non-empty)
		if (unknownList.length > 0) {
			syntheticCalls.push({
				id: "prev_unknown",
				type: "function",
				function: { name: "unknown", arguments: JSON.stringify({ items: unknownList }) },
			});
			toolResults.push({
				role: "tool",
				tool_call_id: "prev_unknown",
				content: JSON.stringify(unknownList),
			});
		}

		messages.push({
			role: "assistant",
			content: null,
			tool_calls: syntheticCalls,
		});
		messages.push(...toolResults);

		// 4. User message
		messages.push({ role: "user", content: userMessage });

		return messages;
	}
}
