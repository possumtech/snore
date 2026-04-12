// Tool doc for <mv>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	// --- Syntax: path attr = source, body = destination
	[
		'## <mv path="[source]">[destination]</mv> - Move or rename a file or entry',
	],

	// --- Examples: entry rename and file move
	[
		'Example: <mv path="known://active_task">known://completed_task</mv>',
		"Entry rename. Most common mv use case. Shows known:// path convention.",
	],
	[
		'Example: <mv path="src/old_name.js">src/new_name.js</mv>',
		"File rename. Shows that mv works on files too, not just known entries.",
	],

	// --- Archive lifecycle
	[
		"* You may move entries or pattern-matching batches of entries to and from the archive to manage your context budget.",
		"Teaches archival as a reversible budget operation, not permanent deletion.",
	],
	[
		'Example: <mv path="known://project/*" fidelity="index"/> ... <mv path="known://project/active_sprint" fidelity="full"/>',
		"Index a whole category to free context while keeping paths visible, restore one entry when needed. No destination = fidelity change in place.",
	],
	[
		"* YOU SHOULD demote irrelevant entries to `index` or `archive` — clean context improves reasoning.",
		"Core curation principle: clean context is a quality signal, not just a budget concern. Teach the model to curate eagerly.",
	],

	// --- Constraints
	[
		"* Source path accepts patterns for batch moves",
		"Pattern support consistent with get/cp/rm.",
	],
	[
		"* In ask mode, destination MUST be a scheme path (not a file)",
		"Mode constraint. Prevents file mutations in ask mode via mv.",
	],
];

export default LINES.map(([text]) => text).join("\n");
