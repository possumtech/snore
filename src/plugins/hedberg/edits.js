// SEARCH/REPLACE blocks → [{search, replace}, …]. Two shapes:
//
//   <<<<<<< SEARCH       (3-12 markers; edit existing content)
//   old
//   =======
//   new
//   >>>>>>> REPLACE
//
//   =======              (3-12 markers; create / no-search variant —
//   new                   search is null, applied as full-body write)
//   >>>>>>> REPLACE
//
// Returns []` when no recognized block is present. The set handler
// reads that as "malformed body" and surfaces it to the model.
export function parseEditContent(content) {
	const blocks = [];

	const mergeRe =
		/<{3,12} SEARCH\n([\s\S]*?)\n={3,12}\n([\s\S]*?)\n>{3,12} REPLACE/g;
	for (const m of content.matchAll(mergeRe)) {
		blocks.push({ search: m[1], replace: m[2] });
	}
	if (blocks.length > 0) return blocks;

	const replaceOnly = /^={3,12}\n([\s\S]*?)\n>{3,12} REPLACE/gm;
	for (const m of content.matchAll(replaceOnly)) {
		blocks.push({ search: null, replace: m[1] });
	}
	return blocks;
}
