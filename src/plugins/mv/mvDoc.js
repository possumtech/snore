// Tool doc for <mv>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	[
		'## <mv path="[source]">[destination]</mv> - Move or rename a file or entry',
	],
	[
		'Example: <mv path="known://active_task">known://completed_task</mv>',
		"Entry rename. Most common mv use case.",
	],
	['Example: <mv path="src/old_name.js">src/new_name.js</mv>', "File rename."],
	[
		'Example: <mv path="known://project/*" fidelity="demoted"/>',
		"Batch fidelity change via pattern. No destination = fidelity in place.",
	],
	[
		"* Source path accepts patterns for batch moves",
		"Pattern support consistent with get/cp/rm.",
	],
	[
		"* Use `preview` to check matches before pattern-based bulk moves",
		"Safety pattern consistent with rm/cp.",
	],
];

export default LINES.map(([text]) => text).join("\n");
