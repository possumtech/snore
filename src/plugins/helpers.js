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
	const slug = await store.slugPath(runId, scheme, path);
	const filter = bodyFilter ? ` body="${bodyFilter}"` : "";
	const total = matches.reduce((s, m) => s + m.tokens, 0);
	const listing = matches.map((m) => `${m.path} (${m.tokens})`).join("\n");
	const prefix = preview ? "PREVIEW " : "";
	const body = `${prefix}${scheme} path="${path}"${filter}: ${matches.length} matched (${total} tokens)\n${listing}`;
	await store.set({
		runId,
		turn,
		path: slug,
		body,
		state: "resolved",
		loopId,
		attributes,
	});
}
