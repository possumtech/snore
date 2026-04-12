// Tool doc for <cp>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	// --- Syntax: path attr = source, body = destination
	['## <cp path="[source]">[destination]</cp> - Copy a file or entry'],

	// --- Examples: single copy, glob batch, cross-scheme
	[
		'Example: <cp path="src/config.js">src/config.backup.js</cp>',
		"Simple file copy. Path = source, body = destination.",
	],
	[
		'Example: <cp path="known://plan_*">known://archive_</cp>',
		"Glob batch copy across known entries. Shows pattern operations on cp.",
	],

	// --- Constraints
	[
		"* Source path accepts patterns: `src/*.js`, `known://draft_*`",
		"Pattern support. Distributes glob teaching beyond get.",
	],
	[
		"* Use `preview` to check matches before bulk copy",
		"Safety pattern consistent with get and rm preview.",
	],
];

export default LINES.map(([text]) => text).join("\n");
