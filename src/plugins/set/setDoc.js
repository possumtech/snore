// Tool doc for <set>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	// --- Syntax: path attr + body = edit content
	['## <set path="[path/to/file]">[edit]</set> - Edit a file or entry'],

	// --- Examples: sed, SEARCH/REPLACE, fidelity control
	[
		'Example: <set path="src/config.js">s/port = 3000/port = 8080/g</set>',
		"Sed syntax: most common edit pattern. Shows s/old/new/ with g flag.",
	],
	[
		`Example: <set path="src/app.js"><<<<<<< SEARCH
// TODO: add error handling
=======
// error handler configured
>>>>>>> REPLACE</set>`,
		"SEARCH/REPLACE block: literal match and replace. Use when sed escaping is complex.",
	],
	[
		'Example: <set path="known://plan" stored summary="Migration plan for Q2"/>',
		"Fidelity + summary: archive an entry while preserving a description. Lifecycle endpoint.",
	],

	// --- Constraints
	[
		'* `fidelity="..."`: `stored`, `summary`, `index`, `full`',
		"Fidelity control via attributes. Replaces the removed <store> tool.",
	],
	[
		'* `summary="..."` (<= 80 chars) persists across fidelity changes',
		"Model-authored descriptions survive demotion. No janitorial pass needed.",
	],
	[
		"* YOU MUST NOT use <sh/> or <env/> to read, create, or edit files",
		"Forces file operations through set/get. Prevents untracked mutations.",
	],
	[
		"* Editing: s/old/new/ sed patterns and literal SEARCH/REPLACE blocks",
		"Both syntaxes supported. Hedberg normalizes either form.",
	],
];

export default LINES.map(([text]) => text).join("\n");
