// Tool doc for <summarize>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	["## <summarize>[answer or summary]</summarize> - Signal completion"],
	[
		"Example: <summarize>The port is 8080</summarize>",
		"Direct answer. Summarize delivers answers.",
	],
	[
		"Example: <summarize>Installed express, updated config</summarize>",
		"Task summary. Action completion.",
	],
	[
		"* YOU MUST use <summarize></summarize> when done — describes the final state",
		"Completion signal.",
	],
	[
		"* YOU MUST NOT use <summarize> if still working — use <update/> instead",
		"Mutual exclusion with update.",
	],
	["* YOU MUST keep <summarize> to <= 80 characters", "Length cap."],
];

export default LINES.map(([text]) => text).join("\n");
