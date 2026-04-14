// Tool doc for <rm>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
  ['## <rm path="[path]"/> - Remove a file or entry'],
  ['Example: <rm path="src/config.js"/>', "File removal. Simplest form."],
  [
    'Example: <rm path="known://temp_*" preview/>',
    "Preview before deleting. Safety pattern for bulk operations.",
  ],
  [
    '* Permanent. Prefer <set fidelity="archive"/> to preserve for later retrieval',
    "Nudges toward archive over rm.",
  ],
  [
    "* Use `preview` to check matches before pattern-based bulk deletion",
    "Reinforces preview safety pattern.",
  ],
];

export default LINES.map(([text]) => text).join("\n");
