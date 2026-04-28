// {"search":"old","replace":"new"} or {search="old",replace="new"} → {search,replace}|null.
export function parseJsonEdit(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !/search/.test(trimmed)) return null;
	try {
		const json = JSON.parse(trimmed);
		if (json.search != null)
			return { search: json.search, replace: json.replace ?? "" };
	} catch {
		const searchMatch = trimmed.match(/search\s*=\s*"([^"]*)"/);
		const replaceMatch = trimmed.match(/replace\s*=\s*"([^"]*)"/);
		if (searchMatch) {
			return { search: searchMatch[1], replace: replaceMatch?.[1] ?? "" };
		}
	}
	return null;
}
