import ToolSchema from "../../domain/schema/ToolSchema.js";

/**
 * Assembles the LLM messages from the known store context.
 *
 * The model receives:
 *   1. system — role description + tool schemas + ordered known context
 *   2. user — empty (prompt is in the known context as the last entry)
 *
 * If no prompt entry exists in context (first turn), user message carries the prompt.
 */
export default class ContextAssembler {
	static assemble({ systemPrompt, mode, context, userMessage }) {
		const sections = [systemPrompt];

		// Inject tool JSON schemas
		const tools = mode === "act" ? ToolSchema.act : ToolSchema.ask;
		const schemaLines = tools.map((t) => {
			const fn = t.function;
			return `### ${fn.name}\n\`\`\`json\n${JSON.stringify(fn.parameters, null, 2)}\n\`\`\``;
		});
		sections.push(`## Tool Schemas\n\n${schemaLines.join("\n\n")}`);

		// The ordered known context — one flat array
		if (context.length > 0) {
			sections.push(`## Context\n\`\`\`json\n${JSON.stringify(context)}\n\`\`\``);
		}

		const messages = [{ role: "system", content: sections.join("\n\n") }];

		// User message only if there's no /:prompt/ entry in context
		const hasPrompt = context.some((e) => e.state === "prompt");
		if (!hasPrompt && userMessage) {
			messages.push({ role: "user", content: userMessage });
		}

		return messages;
	}
}
