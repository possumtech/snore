// Tool doc for <known/>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	// --- Syntax: path = slash-separated topic hierarchy, body = the information to save
	[
		'## <known path="known://topic/subtopic" summary="keyword,keyword,keyword">[specific facts, decisions, or plans]</known> - Sort and save what you learn for later recall',
	],
	// --- Examples: category-level entries — multiple related facts per entry, not one per item
	[
		'Example: <known path="known://config/database" summary="database,host,port,pool,replica">Host: db.internal. Port: 5432. Pool: 10 connections. Replica: db-replica.internal:5432.</known>',
		"Category entry: all database config facts in one entry. Path is an address (topic/subtopic), body collects every related fact, summary is comma-separated search keywords — not a description.",
	],
	[
		'Example: <known path="known://project/milestones" summary="milestone,deadline,alpha,launch,2026">Alpha: 2026-03-01. Beta cutoff: 2026-04-15. GA launch: 2026-06-01.</known>',
		"Timeline entry: all milestone dates under one path. Multiple facts per entry reduces fragmentation. Recall by glob or keyword.",
	],
	// --- Lifecycle
	[
		'* Recall with <get path="known://config/*">replica</get>',
		"Cross-tool lifecycle: glob by category, filter by keyword. Matches the slashed path convention.",
	],
	[
		"* `summary` REQUIRED — comma-separated search keywords that survive at summary fidelity",
		"Summary is a compression label, not a path generator. Path is always explicit.",
	],
	[
		"* Group related facts by topic — one entry per topic category, not one per input chunk",
		"Critical behavioral constraint. Topic grouping enables semantic recall; chunk-based filing creates positional, irretrievable entries.",
	],
];

export default LINES.map(([text]) => text).join("\n");
