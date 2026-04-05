/**
 * Sed syntax parsing. Handles s/search/replace/flags with:
 * - Escaped delimiters (\\/)
 * - Chained commands (s/a/b/ s/c/d/)
 * - Flag extraction (g, i, m, s, v)
 */

function splitSed(str) {
	const parts = [];
	let current = "";
	for (let i = 0; i < str.length; i++) {
		if (str[i] === "\\" && i + 1 < str.length) {
			current += str[i] + str[i + 1];
			i++;
		} else if (str[i] === "/") {
			parts.push(current);
			current = "";
		} else {
			current += str[i];
		}
	}
	parts.push(current);
	return parts;
}

export function parseSed(input) {
	if (!input.startsWith("s/")) return null;

	const blocks = [];
	let remaining = input;
	while (remaining.startsWith("s/")) {
		const parts = splitSed(remaining.slice(2));
		if (parts.length < 2) break;
		const flags = (parts[2] || "").match(/^[gimsv]*/)?.[0] || "";
		blocks.push({
			search: parts[0].replaceAll("\\/", "/"),
			replace: parts[1].replaceAll("\\/", "/"),
			flags,
			sed: true,
		});
		const rest = parts.slice(2).join("/");
		const next = rest.indexOf("s/");
		remaining = next >= 0 ? rest.slice(next) : "";
	}

	if (blocks.length === 0) return null;
	return blocks;
}
