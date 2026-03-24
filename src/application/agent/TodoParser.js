const VALID_VERBS = new Set([
	"read", "env", "edit", "create", "delete", "run", "prompt_user", "summary",
]);

/**
 * TodoParser: Parses verb-prefixed markdown todo lists.
 *
 * Format: `- [x] verb: description`
 * Falls back gracefully for lines without verb prefix (verb = null).
 */
export default class TodoParser {
	static parse(text) {
		if (!text) return { list: [], next: null };

		const lines = text.split(/\r?\n/);
		const list = [];
		let next = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			const match = trimmed.match(/^[-*]\s*\[([ xX])] (.*)$/);
			if (match) {
				const completed = match[1].toLowerCase() === "x";
				const rest = match[2].trim();

				// Try to extract verb prefix: "verb: description"
				const verbMatch = rest.match(/^(\w+):\s*(.*)$/);
				let verb = null;
				let text = rest;

				if (verbMatch && VALID_VERBS.has(verbMatch[1])) {
					verb = verbMatch[1];
					text = verbMatch[2];
				}

				const item = { verb, text, completed };
				list.push(item);

				if (!completed && !next) next = item;
			} else {
				const item = {
					verb: null,
					text: trimmed.replace(/^[-*]\s*/, ""),
					completed: false,
				};
				list.push(item);
				if (!next) next = item;
			}
		}

		return { list, next };
	}

	/**
	 * Cross-references checked action verbs against emitted action tags.
	 * Returns warnings for mismatches.
	 */
	static crossReference(todoList, emittedTagNames) {
		const warnings = [];
		const emittedSet = new Set(emittedTagNames);

		for (const item of todoList) {
			if (!item.verb || !item.completed) continue;
			// read is a gather verb — don't warn if skipped (file may already be in context)
			if (item.verb === "read") continue;
			// summary is handled separately by the summary fallback
			if (item.verb === "summary") continue;

			if (!emittedSet.has(item.verb)) {
				warnings.push(
					`todo "${item.verb}: ${item.text}" marked complete but no <${item.verb}> tag was emitted`,
				);
			}
		}

		return warnings;
	}
}
