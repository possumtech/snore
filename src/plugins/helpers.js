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
