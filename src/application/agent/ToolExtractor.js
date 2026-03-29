const ACT_TOOLS = new Set(["edit", "delete", "run"]);

export default class ToolExtractor {
	/**
	 * Extract structured tool calls from the LLM response message.
	 * @param {object} responseMessage - The assistant message with tool_calls
	 * @returns {{ actionCalls, knownCall, unknownCall, summaryCall, promptCall, flags }}
	 */
	static extract(responseMessage) {
		const toolCalls = responseMessage.tool_calls || [];
		const actionCalls = [];
		let knownCall = null;
		let unknownCall = null;
		let summaryCall = null;
		let promptCall = null;

		for (const tc of toolCalls) {
			const name = tc.function?.name;
			const args = JSON.parse(tc.function?.arguments || "{}");
			const id = tc.id;

			const call = { id, name, args };

			if (name === "known") knownCall = call;
			else if (name === "unknown") unknownCall = call;
			else if (name === "summary") summaryCall = call;
			else if (name === "prompt") promptCall = call;
			else actionCalls.push(call);
		}

		const hasAct = actionCalls.some((c) => ACT_TOOLS.has(c.name));
		const hasReads = actionCalls.some((c) => c.name === "read");

		return {
			actionCalls,
			knownCall,
			unknownCall,
			summaryCall,
			promptCall,
			flags: { hasAct, hasReads },
		};
	}

	/**
	 * Validate that required tools are present.
	 * @returns {string|null} Error message if validation fails, null if ok.
	 */
	static validate({ knownCall, summaryCall }) {
		if (!knownCall) return "Model response missing required 'known' tool call.";
		if (!summaryCall) return "Model response missing required 'summary' tool call.";
		return null;
	}
}
