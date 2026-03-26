/**
 * ToolExtractor: Extracts structured tool invocations from model output.
 *
 * Takes raw parsed tags and produces a clean list of tool calls.
 * Everything downstream consumes these — FindingsManager, exit logic,
 * notifications. The format-specific parsing (XML tags, tool calls, etc.)
 * lives in ResponseParser. This module normalizes to a common shape.
 */

const TOOL_TAGS = new Set([
	"read", "drop", "edit", "create", "delete", "run", "env", "prompt_user",
]);

const STRUCTURAL_TAGS = new Set([
	"todo", "known", "unknown", "summary",
]);

const BREAKING_TOOLS = new Set([
	"edit", "create", "delete", "run", "env", "prompt_user",
]);

export default class ToolExtractor {
	#parser;

	constructor(parser) {
		this.#parser = parser;
	}

	/**
	 * Extract tool invocations and structural content from parsed tags.
	 * Returns { tools, structural, flags }
	 */
	extract(tags) {
		const tools = [];
		const structural = [];

		for (const tag of tags) {
			const name = tag.tagName;

			if (STRUCTURAL_TAGS.has(name)) {
				structural.push({
					name,
					content: this.#parser.getNodeText(tag),
				});
				continue;
			}

			if (!TOOL_TAGS.has(name)) continue;

			const attrs = tag.attrs || [];
			const content = this.#parser.getNodeText(tag);

			if (name === "read" || name === "drop") {
				const path = attrs.find((a) => a.name === "file")?.value;
				if (path) tools.push({ tool: name, path });
			} else if (name === "edit") {
				const path = attrs.find((a) => a.name === "file")?.value;
				if (path) {
					const { search, replace } = this.#parseEditContent(content);
					tools.push({ tool: "edit", path, search, replace, raw: content });
				}
			} else if (name === "create") {
				const path = attrs.find((a) => a.name === "file")?.value;
				if (path) tools.push({ tool: "create", path, content });
			} else if (name === "delete") {
				const path = attrs.find((a) => a.name === "file")?.value;
				if (path) tools.push({ tool: "delete", path });
			} else if (name === "run" || name === "env") {
				tools.push({ tool: name, command: content });
			} else if (name === "prompt_user") {
				tools.push({
					tool: "prompt_user",
					text: content,
					config: this.#parser.parsePromptUser(tag),
				});
			}
		}

		const hasBreaking = tools.some((t) => BREAKING_TOOLS.has(t.tool));
		const hasReads = tools.some((t) => t.tool === "read");
		const hasSummary = structural.some((s) => s.name === "summary");

		return {
			tools,
			structural,
			flags: { hasBreaking, hasReads, hasSummary },
		};
	}

	#parseEditContent(content) {
		const searchMarker = "<<<<<<< SEARCH";
		const dividerMarker = "=======";
		const replaceMarker = ">>>>>>> REPLACE";

		const searchStart = content.indexOf(searchMarker);
		const dividerStart = content.indexOf(dividerMarker);
		const replaceEnd = content.indexOf(replaceMarker);

		if (searchStart === -1 || dividerStart === -1 || replaceEnd === -1) {
			return { search: null, replace: null };
		}

		const search = content
			.substring(searchStart + searchMarker.length, dividerStart)
			.trim();
		const replace = content
			.substring(dividerStart + dividerMarker.length, replaceEnd)
			.trim();

		return { search, replace };
	}
}

export { BREAKING_TOOLS, TOOL_TAGS, STRUCTURAL_TAGS };
