// Tool doc for <known>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	// --- Syntax: body = the information to save
	["## <known>[information]</known> - Save what you learn for later recall"],

	// --- Examples: taxonomic form first (teaches path hierarchy + summary), then simple
	[
		'Example: <known path="known://people/rumsfeld" summary="US Secretary of Defense, born 1932">Donald Rumsfeld was born in 1932 and served as Secretary of Defense</known>',
		"Taxonomic form: slashed path=category/key, summary=keywords, body=detail. Survives crunching with searchable keywords. Category enables glob recall.",
	],
	[
		"Example: <known>Mitch Hedberg died on March 30, 2005</known>",
		"Simple form: auto-slugged path. Works but unsearchable URIs.",
	],

	// --- Lifecycle
	[
		'* Recall with <get path="known://people/*">keyword</get>',
		"Cross-tool lifecycle: glob by category, filter by keyword. Matches the slashed path convention.",
	],
	[
		"* `summary` survives when entries are crunched — write keywords you'll search for later",
		"Teaches WHY summaries matter. The model learns that summary text is what remains visible after budget pressure demotes the entry.",
	],
	[
		"* Entries are your memory — you forget everything not saved as known entries",
		"Critical behavioral constraint. Without this, models assume they'll remember across turns.",
	],
];

export default LINES.map(([text]) => text).join("\n");
