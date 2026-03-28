export default class ToolExtractor {
	#actTools;

	constructor(toolRegistry) {
		this.#actTools =
			toolRegistry?.actTools ??
			new Set(["edit", "delete", "run", "prompt_user"]);
	}

	extract(parsed) {
		const tools = [];

		// Todo-driven tools
		for (const item of parsed.todo) {
			const { tool, argument } = item;
			if (!tool) continue;

			if (tool === "read" || tool === "drop") {
				tools.push({ tool, path: argument });
			} else if (tool === "delete") {
				tools.push({ tool: "delete", path: argument });
			} else if (tool === "env" || tool === "run") {
				tools.push({ tool, command: argument });
			}
		}

		// Edits from the structured edits array
		for (const edit of parsed.edits ?? []) {
			if (!edit.file) continue;
			if (edit.search === "") {
				tools.push({
					tool: "create",
					path: edit.file,
					content: edit.replace ?? "",
				});
			} else {
				tools.push({
					tool: "edit",
					path: edit.file,
					search: edit.search ?? "",
					replace: edit.replace ?? "",
				});
			}
		}

		// Prompt from the structured prompt object
		if (parsed.prompt?.question) {
			tools.push({
				tool: "prompt_user",
				text: parsed.prompt.question,
				config: {
					question: parsed.prompt.question,
					options: (parsed.prompt.options || []).map((o) => ({
						label: o,
						description: o,
					})),
				},
			});
		}

		const hasAct = tools.some((t) => this.#actTools.has(t.tool));
		const hasReads = tools.some((t) => t.tool === "read");

		return { tools, flags: { hasAct, hasReads } };
	}
}
