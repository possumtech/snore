const CONTEXT_LINES = 3;

export function generateUnifiedDiff(filePath, oldContent, newContent) {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");

	// Find first differing line
	let start = 0;
	while (
		start < oldLines.length &&
		start < newLines.length &&
		oldLines[start] === newLines[start]
	) {
		start++;
	}

	// Find last differing line (from the end)
	let oldEnd = oldLines.length - 1;
	let newEnd = newLines.length - 1;
	while (
		oldEnd > start &&
		newEnd > start &&
		oldLines[oldEnd] === newLines[newEnd]
	) {
		oldEnd--;
		newEnd--;
	}

	// Context bounds
	const ctxStart = Math.max(0, start - CONTEXT_LINES);
	const ctxOldEnd = Math.min(oldLines.length - 1, oldEnd + CONTEXT_LINES);
	const ctxNewEnd = Math.min(newLines.length - 1, newEnd + CONTEXT_LINES);

	const hunkLines = [];

	// Leading context
	for (let i = ctxStart; i < start; i++) {
		hunkLines.push(` ${oldLines[i]}`);
	}
	// Removed lines
	for (let i = start; i <= oldEnd; i++) {
		hunkLines.push(`-${oldLines[i]}`);
	}
	// Added lines
	for (let i = start; i <= newEnd; i++) {
		hunkLines.push(`+${newLines[i]}`);
	}
	// Trailing context
	for (let i = oldEnd + 1; i <= ctxOldEnd; i++) {
		hunkLines.push(` ${oldLines[i]}`);
	}

	const oldCount =
		oldEnd - start + 1 + (start - ctxStart) + (ctxOldEnd - oldEnd);
	const newCount =
		newEnd - start + 1 + (start - ctxStart) + (ctxNewEnd - newEnd);

	const header = `@@ -${ctxStart + 1},${oldCount} +${ctxStart + 1},${newCount} @@`;

	return [
		`Index: ${filePath}`,
		"===================================================================",
		`--- ${filePath}\told`,
		`+++ ${filePath}\tnew`,
		header,
		...hunkLines,
		"",
	].join("\n");
}

export default class HeuristicMatcher {
	static matchAndPatch(filePath, fileContent, searchBlock, replaceBlock) {
		const searchLines = searchBlock.split(/\r?\n/);
		const fileLines = fileContent.split(/\r?\n/);

		// 1. Exact Match Attempt (line-boundary substring search)
		// Find all exact matches at line boundaries
		let exactIdx = fileContent.indexOf(searchBlock);
		let lastExactIdx = -1;
		let exactCount = 0;
		while (exactIdx !== -1) {
			const atLineBoundary =
				exactIdx === 0 || fileContent[exactIdx - 1] === "\n";
			if (atLineBoundary) {
				exactCount++;
				lastExactIdx = exactIdx;
			}
			exactIdx = fileContent.indexOf(searchBlock, exactIdx + 1);
		}

		if (exactCount > 0) {
			const useIdx = lastExactIdx;
			const newContent =
				fileContent.slice(0, useIdx) +
				replaceBlock +
				fileContent.slice(useIdx + searchBlock.length);
			const patch = generateUnifiedDiff(filePath, fileContent, newContent);
			const warning =
				exactCount > 1
					? `SEARCH block matched ${exactCount} locations. Edit was applied to the last occurrence. Use more surrounding context in future edits to avoid ambiguity.`
					: null;
			return { patch, newContent, warning, error: null };
		}

		// 2. Fuzzy Tokenized Match (Ignore leading/trailing whitespace per line)
		const searchTokens = searchLines
			.map((l) => l.trim())
			.filter((l) => l !== "");
		const fileTokens = fileLines.map((l) => l.trim());

		if (searchTokens.length === 0) {
			return {
				patch: null,
				warning: null,
				error:
					"SEARCH block is empty or only whitespace. Please provide exact lines to replace.",
			};
		}

		let matchStartIndex = -1;
		let matchEndIndex = -1;
		let matchCount = 0;

		for (let i = 0; i < fileTokens.length; i++) {
			if (fileTokens[i] === "" && searchTokens[0] !== "") continue;

			let searchIdx = 0;
			let fileIdx = i;

			while (searchIdx < searchTokens.length && fileIdx < fileTokens.length) {
				if (fileTokens[fileIdx] === "" && searchTokens[searchIdx] !== "") {
					fileIdx++;
					continue;
				}

				if (fileTokens[fileIdx] === searchTokens[searchIdx]) {
					searchIdx++;
					fileIdx++;
				} else {
					break;
				}
			}

			if (searchIdx === searchTokens.length) {
				matchCount++;
				matchStartIndex = i;
				matchEndIndex = fileIdx - 1;
			}
		}

		if (matchCount === 0) {
			return {
				patch: null,
				warning: null,
				error:
					"Could not find the SEARCH block in the file. Ensure you are providing an exact match of the existing code, without truncating lines with '...'.",
			};
		}

		const fuzzyAmbiguous = matchCount > 1;

		// 3. Indentation Healing
		const matchedFileLines = fileLines.slice(
			matchStartIndex,
			matchEndIndex + 1,
		);

		const firstFileIndentedLine = matchedFileLines.find((l) => l.trim() !== "");
		const fileIndentMatch = firstFileIndentedLine
			? firstFileIndentedLine.match(/^(\s*)/)
			: null;
		const fileIndent = fileIndentMatch ? fileIndentMatch[1] : "";

		const firstSearchIndentedLine = searchLines.find((l) => l.trim() !== "");
		const searchIndentMatch = firstSearchIndentedLine
			? firstSearchIndentedLine.match(/^(\s*)/)
			: null;
		const searchIndent = searchIndentMatch ? searchIndentMatch[1] : "";

		let healedReplaceBlock = replaceBlock;
		let warning = null;

		if (fileIndent !== searchIndent) {
			warning = `Indentation healing applied. The file has different indentation ('${fileIndent.replace(/\t/g, "\\t").replace(/ /g, "s")}') than your SEARCH block. Please try to match indentation exactly in future edits.`;

			const replaceLines = replaceBlock.split(/\r?\n/);
			const healedLines = replaceLines.map((line) => {
				if (line.trim() === "") return line;
				if (line.startsWith(searchIndent)) {
					return fileIndent + line.substring(searchIndent.length);
				}
				return fileIndent + line.trimStart();
			});
			healedReplaceBlock = healedLines.join("\n");
		}

		const newFileLines = [
			...fileLines.slice(0, matchStartIndex),
			healedReplaceBlock,
			...fileLines.slice(matchEndIndex + 1),
		];
		const newContent = newFileLines.join("\n");

		const patch = generateUnifiedDiff(filePath, fileContent, newContent);

		if (fuzzyAmbiguous) {
			warning =
				(warning ? `${warning} ` : "") +
				`SEARCH block matched ${matchCount} locations. Edit was applied to the last occurrence. Use more surrounding context in future edits to avoid ambiguity.`;
		}

		return { patch, newContent, warning, error: null };
	}
}
