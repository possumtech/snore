// Tool doc for <rm>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	// --- Syntax: path attr, self-closing
	['## <rm path="[path]"/> - Remove a file or entry'],

	// --- Examples: file, known (with slug path), preview safety
	['Example: <rm path="src/config.js"/>', "File removal. Simplest form."],
	[
		'Example: <rm path="known://people/rumsfeld"/>',
		"Shows topic-hierarchy path convention. Paths are category/key, not sentence slugs.",
	],
	[
		'Example: <rm path="known://temp_*" preview/>',
		"Preview before deleting. Glob pattern. Safety pattern for bulk operations.",
	],

	// --- Constraints
	[
		'* Permanent. Prefer <set fidelity="archive"/> to preserve for later retrieval',
		"Nudges toward archive over rm. Archive keeps the key; rm deletes permanently.",
	],
	[
		"* Paths accept globs — use `preview` to check matches first",
		"Reinforces preview safety pattern. Prevents accidental bulk deletion.",
	],
];

export default LINES.map(([text]) => text).join("\n");
