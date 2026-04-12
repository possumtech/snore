// Tool doc for <known/>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	// --- Syntax: path = slash-separated topic hierarchy, body = the information to save
	[
		'## <known path="known://topic/subtopic">[specific facts, decisions, or plans]</known> - Sort and save what you learn for later recall',
	],
	// --- Examples: explicit slash path first (canonical pattern)
	[
		'Example: <known path="known://hedberg/comedian" summary="hedberg,comedian,death,2005">Mitch Hedberg died on March 30, 2005</known>',
		"Primary pattern: slash-separated path segments form a topic hierarchy. Path is the address for recall.",
	],
	[
		'Example: <known path="known://people/rumsfeld" summary="rumsfeld,defense,secretary,1932">Donald Rumsfeld was born in 1932 and served as Secretary of Defense</known>',
		"With summary: optional comma-separated keywords survive compression. Path is the taxonomy; summary is the compressed label.",
	],
	// --- Lifecycle
	[
		'* Recall with <get path="known://people/*">keyword</get>',
		"Cross-tool lifecycle: glob by category, filter by keyword. Matches the slashed path convention.",
	],
	[
		"* `summary` keywords survive compression — write keywords you'll search for later",
		"Summary is a compression label, not a path generator. Path is always explicit.",
	],
	[
		"* YOU MUST sort and save all new facts, decisions, and plans in their own <known> entries",
		"Critical behavioral constraint. 'new' prevents re-saving known facts.",
	],
];

export default LINES.map(([text]) => text).join("\n");
