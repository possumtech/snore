// Tool doc for <get>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	// --- Syntax: body-form is the primary invocation (simplest)
	["## <get>[path/to/file]</get> - Load a file or entry into context"],

	// --- Examples: 3 examples covering single file, known recall, and content search
	[
		"Example: <get>src/app.js</get>",
		"Simplest form. Body = path. Teaches that get is the default read tool.",
	],
	[
		'Example: <get path="known://*">auth</get>',
		"Keyword recall: glob in path, search term in body. Cross-scheme hedberg pattern.",
	],
	[
		'Example: <get path="src/**/*.js" preview>authentication</get>',
		"Full pattern: recursive glob + preview + content filter. Shows all 3 features at once. Body is a filter keyword, never file content.",
	],

	// --- Partial read: line/limit — show before constraints so model sees it as a first-class pattern
	[
		'Example: <get path="src/agent/AgentLoop.js" line="644" limit="80"/>',
		"Partial read. Returns lines 644–723 as the log item without promoting the entry to full. Use summary fidelity to find line numbers, then target the symbol directly.",
	],

	// --- Constraints: RFC-style. Each prevents a specific failure mode.
	[
		"* Paths accept patterns: `src/**/*.js`, `known://api_*`",
		"Reinforces picomatch patterns work everywhere, not just in examples.",
	],
	[
		"* `preview` shows matches without loading into context",
		"Budget-awareness. Without this, models load everything and blow context.",
	],
	[
		"* Body text filters results by content match",
		"Generalizes examples 2-3. Body = filter, not just path.",
	],
	[
		"* `line` and `limit` read a slice without promoting — patterns not allowed",
		"The no-promotion constraint is what makes partial read safe: context budget is unaffected.",
	],
	[
		'* Use <set path="..." fidelity="archive"/> to remove loaded content from context',
		"Lifecycle: get→set. Load, read, archive. Prevents context hoarding.",
	],
];

export default LINES.map(([text]) => text).join("\n");
