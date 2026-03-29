/**
 * Assembles the LLM messages array from the known store and user input.
 * No message history. The known entries array IS the model's memory,
 * embedded in the system prompt alongside the role description.
 *
 * Message structure:
 *   1. system — role description + known state + unknown list + summary log
 *   2. user — current input
 */
export default class ContextAssembler {
	/**
	 * @param {object} opts
	 * @param {string} opts.systemPrompt - Role description + behavioral constraints
	 * @param {Array} opts.knownEntries - [{key, state, value}] model-facing projection
	 * @param {Array} opts.unknownList - string[] from previous turn
	 * @param {Array} opts.summaryLog - [{tool, target, status, key, value}] full run log
	 * @param {string} opts.userMessage
	 * @returns {Array} messages array for the LLM API
	 */
	static assemble({ systemPrompt, knownEntries, unknownList, summaryLog, userMessage }) {
		const sections = [systemPrompt];

		if (summaryLog.length > 0) {
			sections.push(`## Log\n\`\`\`json\n${JSON.stringify(summaryLog)}\n\`\`\``);
		}

		if (unknownList.length > 0) {
			sections.push(`## Unknown\n\`\`\`json\n${JSON.stringify(unknownList)}\n\`\`\``);
		}

		if (knownEntries.length > 0) {
			sections.push(`## Known\n\`\`\`json\n${JSON.stringify(knownEntries)}\n\`\`\``);
		}

		return [
			{ role: "system", content: sections.join("\n\n") },
			{ role: "user", content: userMessage },
		];
	}
}
