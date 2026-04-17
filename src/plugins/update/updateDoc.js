// Tool doc for <update>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	[
		'## <update status="N">[brief status]</update> - Status report (one per turn, at the end)',
		"Header defines position, frequency, and status code requirement.",
	],
	[
		'Example: <update status="102">Reading config files</update>',
		"102 = processing, continue. Default if status omitted.",
	],
	[
		'Example: <update status="200">The port is 8080</update>',
		"200 = complete. This terminates the run with the answer.",
	],
	[
		'Example: <update status="204">No matching entries found</update>',
		"204 = complete, nothing to report.",
	],
	[
		'Example: <update status="422">Cannot determine without API access</update>',
		"422 = complete, unable to fulfill.",
	],
	[
		"* Urgent: ONE <update></update> per turn, AT THE END. Not inline narration between tools.",
		"Single-update-per-turn is the missing rule. Model was emitting 3-6 updates per turn as progress commentary.",
	],
	[
		'* If you\'d repeat the same <update></update> as last turn, the work is either stuck or done. Take a different action or set status="200".',
		"Points at the zombie-loop failure mode directly. Gives the model a trigger and a remedy.",
	],
	["* YOU MUST keep <update></update> to <= 80 characters", "Length cap."],
];

export default LINES.map(([text]) => text).join("\n");
