// Tool doc for <ask_user>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	[
		'## <ask_user question="[Question?]">[option1; option2; ...]</ask_user> - Ask the user a question',
	],
	[
		"* YOU SHOULD use for decisions, preferences, or approvals the user must make",
		"Positive framing. Shows what ask_user IS for.",
	],
	[
		"* YOU SHOULD use <get> to find information before asking the user",
		"Gentle redirect. Encourages self-sufficiency.",
	],
	[
		'Example: <ask_user question="Which test framework?">Mocha; Jest; Node Native</ask_user>',
		"Preference decision. Model truly cannot know this without asking.",
	],
	[
		'Example: <ask_user question="Deploy to staging or production?">staging; production</ask_user>',
		"Consequential action. High-stakes choice.",
	],
];

export default LINES.map(([text]) => text).join("\n");
