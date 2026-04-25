import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read a sibling tooldoc markdown file and return its model-facing text.
 * Strips HTML comments (rationale stays in source, never reaches the model)
 * and collapses any blank-line runs left behind. Each plugin's Doc.js is a
 * one-liner that defers to this so authors edit normal markdown instead of
 * a JS array of [text, rationale] pairs.
 */
export function loadDoc(metaUrl, name) {
	const dir = dirname(fileURLToPath(metaUrl));
	return readFileSync(join(dir, name), "utf8")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Translate a log entry path into its companion data-scheme base path.
 * `log://turn_N/{action}/{rest}` → `{action}://turn_N/{rest}`.
 * Streaming producers (sh, env) create data channel entries under the
 * producer scheme while the audit record lives in the log scheme; this
 * helper bridges the two namespaces. Returns null for non-log paths.
 */
export function logPathToDataBase(logPath) {
	const m = logPath?.match(/^log:\/\/turn_(\d+)\/([^/]+)\/(.+)$/);
	if (!m) return null;
	return `${m[2]}://turn_${m[1]}/${m[3]}`;
}

/**
 * Shared helper for pattern-based tool results.
 * Used by get, set, store, and rm tools.
 */
export async function storePatternResult(
	store,
	runId,
	turn,
	scheme,
	path,
	bodyFilter,
	matches,
	{ preview = false, loopId = null, attributes = null } = {},
) {
	const logSlug = await store.logPath(runId, turn, scheme, path);
	const filter = bodyFilter ? ` body="${bodyFilter}"` : "";
	const total = matches.reduce((s, m) => s + m.tokens, 0);
	const listing = matches.map((m) => `${m.path} (${m.tokens})`).join("\n");
	const prefix = preview ? "PREVIEW " : "";
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
