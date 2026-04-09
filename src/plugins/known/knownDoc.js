// Tool doc for <known/>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	// --- Syntax: body = the information to save
	[
		"## <known>[specific information, ideas, or plans]</known> - Sort and save what you learn for later recall",
	],
	[
		"Example: <known>Mitch Hedberg died on March 30, 2005</known>",
		"Simple form: auto-slugged path. Works but unsearchable URIs.",
	],
	// --- Examples: taxonomic form first (teaches path hierarchy + summary), then simple
	[
		'Example: <known path="known://people/rumsfeld" summary="US Secretary of Defense, born 1932">Donald Rumsfeld was born in 1932 and served as Secretary of Defense</known>',
		"Taxonomic form: slashed path=category/key, summary=keywords, body=detail. Survives crunching with searchable keywords. Category enables glob recall.",
	],
	// --- Lifecycle
	[
		'* Recall with <get path="known://people/*">keyword</get>',
		"Cross-tool lifecycle: optionally glob by category, optionally filter by keyword or pattern. Matches the slashed path convention.",
	],
	[
		"* `summary` survives when entries are compressed — write keywords you'll search for later",
		"Teaches WHY summaries matter. The model learns that summary text is what remains visible after budget pressure demotes the entry.",
	],
	[
		"* YOU MUST sort and save all new information, ideas, and plans in their own <known> entries",
		"Critical behavioral constraint. 'new' prevents re-saving known facts. Without this, models assume they'll remember across turns.",
	],
];

export default LINES.map(([text]) => text).join("\n");
