import ToolSchema from "../../domain/schema/ToolSchema.js";

/**
 * Assembles the LLM messages array from the known store and user input.
 * No message history. The known entries array IS the model's memory,
 * embedded in the system prompt.
 *
 * Message structure:
 *   1. system — role description + tool schemas + log + unknown + known entries
 *   2. user — current input
 */
export default class ContextAssembler {
	/**
	 * @param {object} opts
	 * @param {string} opts.systemPrompt - Role description from system.ask.md/system.act.md
	 * @param {string} opts.mode - "ask" or "act"
	 * @param {Array} opts.knownEntries - [{key, state, value}] model-facing projection
	 * @param {Array} opts.unknownList - string[] from previous turn
	 * @param {Array} opts.summaryLog - [{tool, target, status, key, value}]
	 * @param {string} opts.userMessage
	 * @returns {Array} messages array for the LLM API
	 */
	static assemble({ systemPrompt, mode, knownEntries, unknownList, summaryLog, userMessage }) {
		const sections = [systemPrompt];

		// Inject tool JSON schemas
		const tools = mode === "act" ? ToolSchema.act : ToolSchema.ask;
		const schemaLines = tools.map((t) => {
			const fn = t.function;
			return `### ${fn.name}\n\`\`\`json\n${JSON.stringify(fn.parameters, null, 2)}\n\`\`\``;
		});
		sections.push(`## Tool Schemas\n\n${schemaLines.join("\n\n")}`);

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
