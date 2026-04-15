// Tool doc for <summarize>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	[
		"## <summarize>[answer or final summary]</summarize> - Terminate the run with the final answer",
		"Header teaches consequence (run ends), not just label. Model now knows emitting this stops everything.",
	],
	[
		"Example: <summarize>The port is 8080</summarize>",
		"Direct answer. Summarize delivers answers.",
	],
	[
		"* Urgent: <summarize/> ENDS THE RUN. After this, no more turns happen.",
		"Direct statement of terminal behavior — the model treating summarize as a generic 'done message' was causing zombie-update loops (model unsure if truly finished, defaulted to update).",
	],
	[
		"* Urgent: YOU MUST NOT include <summarize/> with other tools. Termination is a deliberate, isolated act — not a side effect of a turn doing other things.",
		"Prior 'they might fail' rationale was argued around (when set on known:// succeeds, model rationalized bundling). Reframing as architectural ('termination is deliberate') removes the argument surface.",
	],
	[
		"* YOU MUST keep <summarize/> to <= 80 characters",
		"Length cap.",
	],
];

export default LINES.map(([text]) => text).join("\n");
