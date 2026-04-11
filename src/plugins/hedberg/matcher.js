import { createTwoFilesPatch } from "diff";

export function generatePatch(filePath, oldContent, newContent) {
	return createTwoFilesPatch(
		`${filePath}\told`,
		`${filePath}\tnew`,
		oldContent,
		newContent,
		"",
		"",
		{ context: 3 },
	);
}

export default class HeuristicMatcher {
	static matchAndPatch(filePath, fileContent, searchBlock, replaceBlock) {
		// Unescape common regex escapes (models often escape brackets, parens, etc.)
		const unescaped = searchBlock.replace(/\\([[\](){}.*+?^$|\\])/g, "$1");
		if (unescaped !== searchBlock && fileContent.includes(unescaped)) {
			searchBlock = unescaped;
		}

		const searchLines = searchBlock.split(/\r?\n/);
		const fileLines = fileContent.split(/\r?\n/);

		// 1. Exact Match Attempt (line-boundary substring search)
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
			const patch = generatePatch(filePath, fileContent, newContent);
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
			// Empty SEARCH = append REPLACE to end of file
			const trailing = fileContent.endsWith("\n") ? "" : "\n";
			const newContent = `${fileContent + trailing + replaceBlock}\n`;
			const patch = generatePatch(filePath, fileContent, newContent);
			return { patch, newContent, warning: null, error: null };
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
					"SEARCH blocks are matched literally, not as a pattern. Could not find the SEARCH block in the file.",
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

		const patch = generatePatch(filePath, fileContent, newContent);

		if (fuzzyAmbiguous) {
			warning =
				(warning ? `${warning} ` : "") +
				`SEARCH block matched ${matchCount} locations. Edit was applied to the last occurrence. Use more surrounding context in future edits to avoid ambiguity.`;
		}

		return { patch, newContent, warning, error: null };
	}
}
