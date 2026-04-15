// Tool doc for <set>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	[
		'## <set path="[path/to/file]">[content or edit]</set> - Create, edit, or update a file or entry',
	],
	[
		'Example: <set path="known://project/milestones" fidelity="demoted" summary="milestone,deadline,2026"/>',
		"Fidelity control first — most unique capability of set.",
	],
	[
		`Example: <set path="src/app.js">
<<<<<<< SEARCH
old text
=======
new text
>>>>>>> REPLACE
</set>`,
		"SEARCH/REPLACE block — primary edit pattern for existing files.",
	],
	[
		'Example: <set path="src/config.js">s/port = 3000/port = 8080/g;s/host = 127.0.0.1/host = localhost/g;</set>',
		"Sed syntax: chained s/old/new/ patterns with semicolons.",
	],
	[
		'Example: <set path="example.md">Full file content here</set>',
		"Create: body contents are entire file.",
	],
];

export default LINES.map(([text]) => text).join("\n");
