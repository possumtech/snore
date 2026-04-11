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
		'Example: <get path="src/**/*.js" preview>TODO</get>',
		"Full pattern: recursive glob + preview + content filter. Shows all 3 features at once.",
	],

	// --- Constraints: RFC-style. Each prevents a specific failure mode.
	[
		"* Paths accept globs: `src/**/*.js`, `known://api_*`",
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
		'* Use <set path="..." fidelity="archive"/> to remove loaded content from context',
		"Lifecycle: get→set. Load, read, archive. Prevents context hoarding.",
	],
];

export default LINES.map(([text]) => text).join("\n");
