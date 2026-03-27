const VALID_TOOLS = new Set([
	"read",
	"drop",
	"env",
	"edit",
	"create",
	"delete",
	"run",
	"prompt_user",
	"summary",
]);

/**
 * TodoParser: Parses tool-prefixed markdown todo lists.
 *
 * Format: `- [x] tool: argument # description`
 * The `# description` part is optional (for the model's own planning notes).
 * Falls back gracefully for lines without tool prefix (tool = null).
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

				// Extract tool: try "tool: argument # description"
				let tool = null;
				let argument = rest;
				let description = null;

				const colonMatch = rest.match(/^(\w+):\s*(.*)$/);
				if (colonMatch && VALID_TOOLS.has(colonMatch[1])) {
					tool = colonMatch[1];
					const afterColon = colonMatch[2];
					// Split on " # " to separate argument from description
					const hashIdx = afterColon.indexOf(" # ");
					if (hashIdx !== -1) {
						argument = afterColon.substring(0, hashIdx).trim();
						description = afterColon.substring(hashIdx + 3).trim();
					} else {
						argument = afterColon.trim();
					}
				} else {
					// Fallback: try "tool argument" (no colon)
					const spaceMatch = rest.match(/^(\w+)\s+(.*)$/);
					if (spaceMatch && VALID_TOOLS.has(spaceMatch[1])) {
						tool = spaceMatch[1];
						argument = spaceMatch[2];
					}
				}

				const item = { tool, argument, description, completed };
				list.push(item);

				if (!completed && !next) next = item;
			} else {
				const item = {
					tool: null,
					argument: trimmed.replace(/^[-*]\s*/, ""),
					description: null,
					completed: false,
				};
				list.push(item);
				if (!next) next = item;
			}
		}

		return { list, next };
	}

}

export { VALID_TOOLS };
