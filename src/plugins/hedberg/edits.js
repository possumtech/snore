// SEARCH/REPLACE blocks → [{search, replace}, …].
//
// Always three markers (3-12 chars each). Empty SEARCH section is the
// creation idiom — the model can emit `<<<<<<< SEARCH\n=======\n…`
// with no content between SEARCH and `=======`. The `\n?` after the
// search capture lets that empty-content form match the same regex
// as content-bearing edits.
//
//   <<<<<<< SEARCH
//   old           (omit for creates)
//   =======
//   new
//   >>>>>>> REPLACE
//
// Returns [] when no recognized block is present. The set handler
// reads that as "malformed body" and surfaces it to the model.
export function parseEditContent(content) {
	const blocks = [];
	const mergeRe =
		/<{3,12} SEARCH\n([\s\S]*?)\n?={3,12}\n([\s\S]*?)\n>{3,12} REPLACE/g;
	for (const m of content.matchAll(mergeRe)) {
		blocks.push({ search: m[1], replace: m[2] });
	}
	return blocks;
}
