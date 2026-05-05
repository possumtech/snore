// Parses s/search/replace/flags with escaped delimiters, chains, and g/i/m/s/v flags.
function splitSed(str, delim) {
	const parts = [];
	let current = "";
	const escaped = `\\${delim}`;
	for (let i = 0; i < str.length; i++) {
		if (str[i] === "\\" && i + 1 < str.length) {
			current += str[i] + str[i + 1];
			i++;
		} else if (str[i] === delim) {
			parts.push(current);
			current = "";
		} else {
			current += str[i];
		}
	}
	parts.push(current);
	return { parts, escaped };
}

export function parseSed(input) {
	// Sed allows any non-alphanumeric delimiter: s/old/new/, s|old|new|, s#old#new#
	const match = input.match(/^s([^\w\s])/);
	if (!match) return null;

	const delim = match[1];
	const blocks = [];
	let remaining = input;
	const prefix = `s${delim}`;

	while (remaining.startsWith(prefix)) {
		const { parts, escaped } = splitSed(remaining.slice(2), delim);
		if (parts.length < 2) break;

		// Extract flags from the start of the trailing parts; allow an
		// optional chain after (whitespace/semicolons + next `s{delim}`).
		// Anything else means the sed expression is malformed — usually
		// an unescaped delimiter inside SEARCH or REPLACE that caused the
		// split to over-tokenize. Refuse rather than silently mis-apply.
		const trailer = parts.slice(2).join(delim);
		const flagsMatch = trailer.match(/^([gimsv]*)([\s\S]*)$/);
		const flags = flagsMatch[1];
		const afterFlags = flagsMatch[2].replace(/^[\s;]+/, "");

		if (afterFlags && !afterFlags.startsWith(prefix)) {
			throw new Error(
				`Malformed sed: extra content after ${prefix}SEARCH${delim}REPLACE${delim}FLAGS — likely an unescaped '${delim}' inside SEARCH or REPLACE. Use a different delimiter (e.g., s|old|new|g or s,old,new,g) or escape with \\${delim}.`,
			);
		}

		const unesc = (s) => s.replaceAll(escaped, delim);
		blocks.push({
			search: unesc(parts[0]),
			replace: unesc(parts[1]),
			flags,
			sed: true,
		});

		remaining = afterFlags || "";
	}

	if (blocks.length === 0) return null;
	return blocks;
}
