import { createPatch } from "diff";

export default class HeuristicMatcher {
	/**
	 * Attempts to align a SEARCH/REPLACE block with the actual file content.
	 * Returns an object with { patch, warning, error }.
	 */
	static matchAndPatch(filePath, fileContent, searchBlock, replaceBlock) {
		const searchLines = searchBlock.split(/\r?\n/);
		const fileLines = fileContent.split(/\r?\n/);

		// 1. Exact Match Attempt (Strict: must match whole lines)
		// We'll skip this and use the fuzzy logic for everything to ensure indentation healing works consistently.

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

		// Sliding window search across the file
		for (let i = 0; i < fileTokens.length; i++) {
			let searchIdx = 0;
			let fileIdx = i;

			while (searchIdx < searchTokens.length && fileIdx < fileTokens.length) {
				// Skip blank lines in target file
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

		if (matchCount > 1) {
			return {
				patch: null,
				warning: null,
				error:
					"The SEARCH block matched multiple locations in the file. Please include more surrounding context lines in the SEARCH block to make it unique.",
			};
		}

		// 3. Indentation Healing
		// Extract the exact matched lines from the original file
		const matchedFileLines = fileLines.slice(
			matchStartIndex,
			matchEndIndex + 1,
		);

		// Find the indentation of the first non-empty line in the matched file section
		const firstFileIndentedLine = matchedFileLines.find((l) => l.trim() !== "");
		const fileIndentMatch = firstFileIndentedLine
			? firstFileIndentedLine.match(/^(\s*)/)
			: null;
		const fileIndent = fileIndentMatch ? fileIndentMatch[1] : "";

		// Find the indentation of the first non-empty line in the SEARCH block
		const firstSearchIndentedLine = searchLines.find((l) => l.trim() !== "");
		const searchIndentMatch = firstSearchIndentedLine
			? firstSearchIndentedLine.match(/^(\s*)/)
			: null;
		const searchIndent = searchIndentMatch ? searchIndentMatch[1] : "";

		// Apply the delta to the replace block
		let healedReplaceBlock = replaceBlock;
		let warning = null;

		if (fileIndent !== searchIndent) {
			warning = `Indentation healing applied. The file has different indentation ('${fileIndent.replace(/\t/g, "\\t").replace(/ /g, "s")}') than your SEARCH block. Please try to match indentation exactly in future edits.`;

			const replaceLines = replaceBlock.split(/\r?\n/);
			const healedLines = replaceLines.map((line) => {
				if (line.trim() === "") return line;
				// Strip the search indent and apply the file indent
				if (line.startsWith(searchIndent)) {
					return fileIndent + line.substring(searchIndent.length);
				}
				// If it doesn't strictly match the search indent, just prepend the base indent
				return fileIndent + line.trimStart();
			});
			healedReplaceBlock = healedLines.join("\n");
		}

		// Construct the final file content
		const newFileLines = [
			...fileLines.slice(0, matchStartIndex),
			healedReplaceBlock,
			...fileLines.slice(matchEndIndex + 1),
		];
		const newContent = newFileLines.join("\n");

		// Generate the Unified Diff
		const patch = createPatch(filePath, fileContent, newContent, "old", "new");

		return { patch, warning, error: null };
	}
}
