// SEARCH/REPLACE merge format — single source of truth.
//
// A merge is a string of one or more SEARCH/REPLACE blocks describing
// a transformation. Empty SEARCH text means "create new" or "replace
// whole body" (used for full-file writes and copy-to-empty); non-empty
// SEARCH text is matched verbatim and substituted once (used for edits).
//
// Multiple blocks may be concatenated and are applied in order.

const BLOCK_RE =
	/<<<<<<< SEARCH\n?([\s\S]*?)\n?=======\n?([\s\S]*?)\n?>>>>>>> REPLACE/;

/**
 * Construct a single SEARCH/REPLACE block.
 * @param {string} searchText — verbatim text to match; empty = whole-body replace
 * @param {string} replaceText — replacement text
 * @returns {string} a block string suitable for {@link applyMerge}
 */
export function buildMerge(searchText, replaceText) {
	if (!searchText)
		return `<<<<<<< SEARCH\n=======\n${replaceText}\n>>>>>>> REPLACE`;
	return `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`;
}

/**
 * Apply one or more SEARCH/REPLACE blocks to a body.
 * Empty SEARCH → replaces the whole body. Non-empty SEARCH → matched
 * verbatim and substituted (first occurrence only). Blocks with no
 * matching SEARCH are skipped silently — caller is responsible for
 * checking the diff if strict matching is required.
 *
 * @param {string} body — current body
 * @param {string} merge — one or more concatenated blocks
 * @returns {string} the patched body
 */
export function applyMerge(body, merge) {
	const blocks = merge.split(/(?=<<<<<<< SEARCH)/);
	let patched = body;
	for (const block of blocks) {
		const m = block.match(BLOCK_RE);
		if (!m) continue;
		if (m[1] === "") {
			patched = m[2];
		} else {
			patched = patched.replace(m[1], m[2]);
		}
	}
	return patched;
}
