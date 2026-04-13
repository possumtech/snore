// Tool doc for <update>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	["## <update>[brief status]</update> - Signal continuation"],
	[
		"Example: <update>Reading config files</update>",
		"Progress checkpoint. Status signal, not a log entry.",
	],
	[
		"Example: <update>Found 3 issues, fixing first</update>",
		"Multi-step progress. Ongoing work.",
	],
	[
		"* YOU MUST use <update></update> if still working — describes the current state",
		"Continuation signal. Triggers the next turn.",
	],
	[
		"* YOU MUST NOT use <update> if done — use <summarize/> instead",
		"Mutual exclusion with summarize.",
	],
	["* YOU MUST keep <update> to <= 80 characters", "Length cap."],
];

export default LINES.map(([text]) => text).join("\n");
