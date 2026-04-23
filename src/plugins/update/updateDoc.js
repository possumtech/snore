// Tool doc for <update>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
	[
		'## <update status="N">[brief status]</update> - Status report (exactly one per turn, at the end)',
		"Header defines position, frequency, and status code requirement.",
	],
	[
		"REQUIRED: the valid values of N are defined by your current phase instructions.",
		"Single source of truth for codes is the phase preamble, not this doc. Listing codes here leaks termination knowledge (e.g. 200) that strong models use to short-circuit the protocol.",
	],
	[
		"REQUIRED: YOU MUST keep <update></update> body to <= 80 characters.",
		"Length cap.",
	],
];

export default LINES.map(([text]) => text).join("\n");
