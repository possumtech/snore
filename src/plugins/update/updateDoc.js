// Tool doc for <update>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
  [
    '## <update status="N">[brief status]</update> - Status report (ONLY one per turn, at the end)',
    "Header defines position, frequency, and status code requirement.",
  ],
  [
    'Example: <update status="102">Reading config files</update>',
    "102 = processing, continue. Default if status omitted.",
  ],
  [
    'Example: <update status="200">The capital of France is Paris</update>',
    "200 = complete. This successfully terminates the run with the answer.",
  ],
  [
    'Example: <update status="422">Cannot fulfill request</update>',
    "422 = complete, unable to fulfill.",
  ],
  [
    "REQUIRED: YOU MUST keep <update></update> to <= 80 characters",
    "Length cap.",
  ],
];

export default LINES.map(([text]) => text).join("\n");
