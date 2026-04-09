// Tool doc for <unknown>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	// --- Syntax: body = what you need to learn
	[
		`## <unknown>[specific thing I need to learn]</unknown> - Track open questions`,
	],

	// --- Examples: concrete unknowns, not abstract
	[
		`Example: <unknown path="unknown://answer">contents of answer.txt</unknown>`,
		`Specific and actionable. Shows that unknowns are concrete investigation targets.`,
	],
	[
		`Example: <unknown>which database adapter is configured</unknown>`,
		`Domain question. Shows unknowns for configuration/architecture questions.`,
	],

	// --- Lifecycle: register → investigate → resolve
	[
		`* Investigate with Tool Commands`,
		`Cross-tool lifecycle: unknowns drive get/env/ask_user actions.`,
	],
	[
		`* When resolved or irrelevant, remove with <rm path="unknown://..."/>`,
		`Cross-tool lifecycle: rm cleans resolved unknowns from context.`,
	],
];

export default LINES.map(([text]) => text).join("\n");
