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
		'Example: <set path="known://rumsfeld" fidelity="summary" summary="defense/secretary/iraq"/> ... <set path="prompt://3" fidelity="index"/>',
		"Fidelity control: compress a known entry to keywords, demote a previous prompt to index-only. Both free context while keeping paths visible.",
	],

	// --- Constraints
	[
		'* `fidelity="..."`: `archive`, `summary`, `index`, `full`',
		"Fidelity control. Archive removes from context but preserves for retrieval.",
	],
	[
		'* `fidelity="summary"` HIDES the body — does NOT require reading or compressing content. Write any short keyword label you already know.',
		"M-10 fix: model was reading files before compressing to summary, believing it needed semantic content. It does not. The body is preserved on disk; only context visibility changes.",
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
