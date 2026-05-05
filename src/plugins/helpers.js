import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// env/sh stdout/stderr summary projection: lesser of MAX_LINES lines or
// MAX_CHARS characters from the tail of the body. The line cap is the
// natural unit when the program emits text; the character cap protects
// against unbounded growth from output that has few or no newlines —
// e.g. terminal-control programs (cmatrix, htop) emit megabyte-scale
// streams of ANSI escape codes that split into a single "line." The
// header tells the model what slice it's seeing so it can <get line="N"
// limit="M"/> for the rest without re-running the command.
export function streamSummary(label, entry, MAX_LINES = 20, MAX_CHARS = 480) {
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
	const charCapped = lineTail.length > MAX_CHARS;
	const tail = charCapped ? lineTail.slice(-MAX_CHARS) : lineTail;
	let header;
	if (charCapped) {
		header = `# ${label} ${command} (${channel}, tail ${MAX_CHARS} of ${body.length} chars; <get line="1" limit="N"/> for head)`;
	} else if (total <= MAX_LINES) {
		header = `# ${label} ${command} (${channel}, ${total}L)`;
	} else {
		const startLine = total - MAX_LINES + 1;
		header = `# ${label} ${command} (${channel}, lines ${startLine} through ${total} of ${total}; <get line="1" limit="N"/> for head)`;
	}
	return `${header}\n${tail}`;
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
