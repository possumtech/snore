// Tool doc for <get>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	["## <get>[path/to/file]</get> - Load a file or entry into context"],
	["Example: <get>src/app.js</get>", "Simplest form. Body = path."],
	[
		'Example: <get path="known://*">auth</get>',
		"Keyword recall: glob in path, search term in body.",
	],
	[
		'Example: <get path="src/**/*.js" preview>authentication</get>',
		"Full pattern: recursive glob + preview + content filter.",
	],
	[
		'Example: <get path="src/agent/AgentLoop.js" line="644" limit="80"/>',
		"Partial read. Returns lines 644–723 without promoting.",
	],
	[
		"* Paths accept patterns: `src/**/*.js`, `known://api_*`",
		"Reinforces picomatch patterns work everywhere.",
	],
	[
		"* `preview` lists matches without loading into context",
		"Budget-awareness. Preview avoids promotion.",
	],
	[
		"* Body text filters results by content match",
		"Body = filter, not just path.",
	],
	[
		"* `line` and `limit` read a slice without promoting — patterns not allowed",
		"Partial read is safe: context budget unaffected.",
	],
	[
		'* Use <set path="src/file.txt" fidelity="demoted"/> when the content is irrelevant to save tokens.',
		"Cross-tool lifecycle: get promotes, set demotes.",
	],
];

export default LINES.map(([text]) => text).join("\n");
