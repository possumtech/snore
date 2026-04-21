// Tool doc for unknown:// entries. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	[
		'## <set path="unknown://{question}">[specific thing I need to learn]</set> - Register gaps for research',
		"Use <set> to write unknown entries (not <unknown>). Matches preamble examples.",
	],
	[
		'Example: <set path="unknown://answer" summary="answer,contents">contents of answer.txt</set>',
		"Path form: explicit unknown path for structured tracking.",
	],
	[
		"* Investigate with Tool Commands",
		"Unknowns drive action — get, env, search, ask_user.",
	],
	[
		'* When resolved or irrelevant, remove with <set path="unknown://..." visibility="archived"/>',
		"Archive instead of delete — preserves the question for context history.",
	],
];

export default LINES.map(([text]) => text).join("\n");
