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

// env/sh stdout/stderr summary projection: header with line range + last
// TAIL_LINES of body. The header tells the model exactly which slice is
// shown so it can issue <get line="N" limit="M"/> for the rest without
// re-running the command.
export function streamSummary(label, entry, TAIL_LINES = 12) {
	if (!entry.body) return "";
	const { body, attributes } = entry;
	const command = attributes.command;
	const channel = attributes.channel === 2 ? "stderr" : "stdout";
	const trailingNewline = body.endsWith("\n");
	const lines = trailingNewline
		? body.slice(0, -1).split("\n")
		: body.split("\n");
	const total = lines.length;
	if (total <= TAIL_LINES) {
		return `# ${label} ${command} (${channel}, ${total}L)\n${body}`;
	}
	const startLine = total - TAIL_LINES + 1;
	const tail =
		lines.slice(-TAIL_LINES).join("\n") + (trailingNewline ? "\n" : "");
	return `# ${label} ${command} (${channel}, tail L${startLine}-${total}/${total}; <get line="1" limit="N"/> for head)\n${tail}`;
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
