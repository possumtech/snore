// Tool doc for <env>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	["## <env>[command]</env> - Run an exploratory shell command"],
	[
		"Example: <env>npm --version</env>",
		"Version check. Safe, no side effects.",
	],
	[
		"Example: <env>git log --oneline -5</env>",
		"Git history. Shows env for read-only investigation.",
	],
	[
		'* YOU MUST NOT use <env/> to read or list files — use <get path="*"/> instead',
		"Prevents cat/ls through shell. Forces file access through get.",
	],
	[
		"* YOU MUST NOT use <env/> for commands with side effects",
		"Separates exploration from action. env = observe only.",
	],
];

export default LINES.map(([text]) => text).join("\n");
