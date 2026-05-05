import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Hard system ceiling on the size of any summarized projection. Single
// source of truth — every plugin's `summarized` view must produce output
// ≤ this many characters; materializeContext's defensive cap fires when
// a plugin breaks the contract. Change this number, everything downstream
// stays consistent (no "450 here, 480 there, 500 over yonder" drift).
export const SUMMARY_MAX_CHARS = 500;

// Render a single entry as a heredoc-fenced block. Replaces the prior
// per-plugin XML tag rendering (`<known path="..." ...>body</known>`).
//
// Why heredoc, not XML: the model emits XML for actions (`<set>`,
// `<get>`, `<sh>`). When entries were ALSO XML, the inner tag could
// look indistinguishable from a tool call — a file containing a
// `<set>` example, an env streamed-stdout containing tool-shaped text,
// or the model's own `<known>` body containing accidental tag-shaped
// content could leak into the model's emit pattern. Heredoc fences
// have zero training prior in tool-emission position, so they're
// structurally separate from the action grammar.
//
// Format: `{json-meta} <<:::{path}\n{body}\n:::{path}`. The path is the
// terminator — collision requires the body to literally contain its own
// URI on a line by itself, which is vanishingly rare without active
// malice. JSON metadata is sorted-key stringified for prefix-cache
// stability (different field order = different bytes = cache miss).
export function renderEntry(path, metadata, body) {
	const meta = canonicalJson(metadata);
	if (!body) {
		return `${meta} <<:::${path}\n:::${path}`;
	}
	const trailingNewline = body.endsWith("\n") ? "" : "\n";
	return `${meta} <<:::${path}\n${body}${trailingNewline}:::${path}`;
}

// JSON.stringify with sorted top-level keys for byte-stable output.
function canonicalJson(obj) {
	const keys = Object.keys(obj).sort();
	const sorted = {};
	for (const k of keys) sorted[k] = obj[k];
	return JSON.stringify(sorted);
}

// Read sibling tooldoc .md; strips HTML comments (rationale stays out of the model packet).
export function loadDoc(metaUrl, name) {
	const dir = dirname(fileURLToPath(metaUrl));
	return readFileSync(join(dir, name), "utf8")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// log://turn_N/{action}/{rest} → {action}://turn_N/{rest}; null if not a log path.
export function logPathToDataBase(logPath) {
	const m = logPath?.match(/^log:\/\/turn_(\d+)\/([^/]+)\/(.+)$/);
	if (!m) return null;
	return `${m[2]}://turn_${m[1]}/${m[3]}`;
}

// env/sh stdout/stderr summary projection: line-tail with a final hard
// truncation to SUMMARY_MAX_CHARS. The line cap is the natural unit
// when the program emits text; the final size cap is the contract floor
// (see materializeContext) and protects against few-newline output like
// terminal-control programs (cmatrix, htop) emitting one giant ANSI line.
//
// Output stays as a flat string (not a renderEntry block) because the
// caller (log.assembleLog) wraps each log entry in renderEntry with its
// own metadata; this is the BODY of that block. Effectively double
// fencing — `<<:::log://turn_3/sh/foo` outer, then this header inside —
// but that's correct: the outer fence labels "this is sh activity at
// turn 3", and the body inside is the slice of stdout the model sees.
export function streamSummary(label, entry, MAX_LINES = 20) {
	if (!entry.body) return "";
	const { body, attributes } = entry;
	const command = attributes.command;
	const channel = attributes.channel === 2 ? "stderr" : "stdout";
	const trailingNewline = body.endsWith("\n");
	const lines = trailingNewline
		? body.slice(0, -1).split("\n")
		: body.split("\n");
	const total = lines.length;
	const lineTail =
		total <= MAX_LINES
			? body
			: lines.slice(-MAX_LINES).join("\n") + (trailingNewline ? "\n" : "");

	const header =
		total <= MAX_LINES
			? `# ${label} ${command} (${channel}, ${total}L)`
			: `# ${label} ${command} (${channel}, lines ${total - MAX_LINES + 1} through ${total} of ${total}; <get line="1" limit="N"/> for head)`;

	const out = `${header}\n${lineTail}`;
	return out.length > SUMMARY_MAX_CHARS ? out.slice(0, SUMMARY_MAX_CHARS) : out;
}

// Pattern-result log entry shared by get/set/store/rm.
export async function storePatternResult(
	store,
	runId,
	turn,
	scheme,
	path,
	bodyFilter,
	matches,
	{ manifest = false, loopId = null, attributes = null } = {},
) {
	const logSlug = await store.logPath(runId, turn, scheme, path);
	const filter = bodyFilter ? ` body="${bodyFilter}"` : "";
	const total = matches.reduce((s, m) => s + m.tokens, 0);
	const listing = matches.map((m) => `${m.path} (${m.tokens})`).join("\n");
	const prefix = manifest ? "MANIFEST " : "";
	const body = `${prefix}${scheme} path="${path}"${filter}: ${matches.length} matched (${total} tokens)\n${listing}`;
	await store.set({
		runId,
		turn,
		path: logSlug,
		body,
		state: "resolved",
		loopId,
		attributes,
	});
}
