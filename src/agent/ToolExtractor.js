const ACT_TOOLS = new Set(["edit", "delete", "run"]);

export default class ToolExtractor {
	/**
	 * Extract structured tool calls from the LLM response message.
	 * @param {object} responseMessage - The assistant message with tool_calls
	 * @returns {{ actionCalls, writeCalls, unknownCalls, summaryCall, promptCall, flags }}
	 */
	static extract(responseMessage) {
		const toolCalls = responseMessage.tool_calls || [];
		const actionCalls = [];
		const writeCalls = [];
		const unknownCalls = [];
		let summaryCall = null;
		let askUserCall = null;

		for (const tc of toolCalls) {
			const name = tc.function?.name;
			const args = JSON.parse(tc.function?.arguments || "{}");
			const id = tc.id;
			const call = { id, name, args };

			if (name === "write") writeCalls.push(call);
			else if (name === "unknown") unknownCalls.push(call);
			else if (name === "summary") summaryCall = call;
			else if (name === "ask_user") askUserCall = call;
			else actionCalls.push(call);
		}

		const hasAct = actionCalls.some((c) => ACT_TOOLS.has(c.name));
		const hasReads = actionCalls.some((c) => c.name === "read");

		return {
			actionCalls,
			writeCalls,
			unknownCalls,
			summaryCall,
			askUserCall,
			flags: { hasAct, hasReads },
		};
	}

	/**
	 * Validate that required tools are present.
	 * @returns {string|null} Error message if validation fails, null if ok.
	 */
	static validate({ summaryCall }) {
		if (!summaryCall) return "Model response missing required 'summary' tool call.";
		return null;
	}
}
