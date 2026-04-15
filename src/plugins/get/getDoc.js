// Tool doc for <get>. Each entry: [text, rationale].
// Text goes to the model. Rationale stays in source.
// Changing ANY line requires reading ALL rationales first.
const LINES = [
  ["## <get>[path/to/file]</get> - Promote an entry"],
  ["Example: <get>src/app.js</get>", "Simplest form. Body = path."],
  [
    'Example: <get path="known://*">auth</get>',
    "Keyword recall: glob in path, search term in body.",
  ],
  [
    'Example: <get path="src/**/*.js">authentication</get>',
    "Full pattern: recursive glob + content filter.",
  ],
  [
    'Example: <get path="src/agent/AgentLoop.js" line="644" limit="80"/>',
    "Partial read. Returns lines 644–723 without promoting.",
  ],
  [
    "* Paths accept patterns: `src/**/*.js`, `known://api_*`",
    "Reinforces picomatch patterns work everywhere.",
  ],
  [
    "* Body text filters results by content match",
    "Body = filter, not just path.",
  ],
  [
    "* `line` and `limit` read a slice without promoting the entry, which costs as many tokens as the slice contains.",
    "Partial read is safe: context budget unaffected.",
  ],
];

export default LINES.map(([text]) => text).join("\n");
