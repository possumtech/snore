// Detects merge-conflict / replace-only / udiff / Claude XML edits → {search,replace}; SPEC #hedberg.
export function parseEditContent(content) {
	const blocks = [];

	// Format 1: Git merge conflict style (3-12 marker chars)
	const mergeRe =
		/<{3,12} SEARCH\n([\s\S]*?)\n={3,12}\n([\s\S]*?)\n>{3,12} REPLACE/g;
	for (const m of content.matchAll(mergeRe)) {
		blocks.push({ search: m[1], replace: m[2] });
	}
	if (blocks.length > 0) return blocks;

	// Format 2: Replace-only (no search block, 3-12 marker chars)
	const replaceOnly = /^={3,12}\n([\s\S]*?)\n>{3,12} REPLACE/gm;
	for (const m of content.matchAll(replaceOnly)) {
		blocks.push({ search: null, replace: m[1] });
	}
	if (blocks.length > 0) return blocks;

	// Format 3: Unified diff
	if (
		content.includes("@@") &&
		(content.includes("\n-") || content.includes("\n+"))
	) {
		const hunks = content.split(/^@@[^@]*@@/m).slice(1);
		for (const hunk of hunks) {
			const oldLines = [];
			const newLines = [];
			for (const line of hunk.split("\n")) {
				if (line.startsWith("-")) oldLines.push(line.slice(1));
				else if (line.startsWith("+")) newLines.push(line.slice(1));
				else if (line.startsWith(" ")) {
					oldLines.push(line.slice(1));
					newLines.push(line.slice(1));
				}
			}
			if (oldLines.length > 0 || newLines.length > 0) {
				blocks.push({
					search: oldLines.join("\n"),
					replace: newLines.join("\n"),
				});
			}
		}
	}
	if (blocks.length > 0) return blocks;

	// Format 4: Claude XML style
	const claudeRe =
		/<old_text>([\s\S]*?)<\/old_text>\s*<new_text>([\s\S]*?)<\/new_text>/g;
	for (const m of content.matchAll(claudeRe)) {
		blocks.push({ search: m[1], replace: m[2] });
	}

	return blocks;
}
