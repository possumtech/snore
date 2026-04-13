// Tool doc for <think/>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	["## <think>[reasoning]</think> - Think before acting"],
	[
		"* Use <think> before any other tools to plan your approach",
		"Positioning: think first, then act. Prevents degenerate tool-call storms.",
	],
	[
		"* Reasoning inside <think> is private — it does not appear in your context",
		"Frees the model to reason without consuming context budget.",
	],
];

export default LINES.map(([text]) => text).join("\n");
