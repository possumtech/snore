// Tool doc for <update>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	[
		"## <update>[brief status]</update> - Heartbeat for ongoing work (one per turn, at the end)",
		"Header defines position and frequency. Without this, model uses update as inline narration between tools — multiple updates per turn.",
	],
	[
		"Example: <update>Reading config files</update>",
		"Progress checkpoint. Status signal, not a log entry.",
	],
	[
		"Example: <update>Found 3 issues, fixing first</update>",
		"Multi-step progress. Ongoing work.",
	],
	[
		"* Urgent: ONE <update></update> per turn, AT THE END. Not inline narration between tools.",
		"Single-update-per-turn is the missing rule. Model was emitting 3-6 updates per turn as progress commentary.",
	],
	[
		"* If you'd repeat the same <update></update> as last turn, the work is either stuck or done. Take a different action or <summarize></summarize>.",
		"Points at the zombie-loop failure mode directly. Gives the model a trigger (same-text-as-prior-update) and two remedies.",
	],
	["* YOU MUST keep <update></update> to <= 80 characters", "Length cap."],
];

export default LINES.map(([text]) => text).join("\n");
