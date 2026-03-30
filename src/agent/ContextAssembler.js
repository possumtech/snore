import { extname } from "node:path";
import ToolSchema from "../schema/ToolSchema.js";

const EXT_LANG = {
	".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
	".ts": "ts", ".tsx": "tsx",
	".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
	".java": "java", ".kt": "kotlin", ".cs": "csharp",
	".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp",
	".lua": "lua", ".sh": "bash", ".zsh": "bash",
	".sql": "sql", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
	".toml": "toml", ".xml": "xml", ".html": "html", ".css": "css",
	".md": "markdown", ".swift": "swift", ".php": "php", ".r": "r",
};

function langFor(filePath) {
	return EXT_LANG[extname(filePath)] || "";
}

/**
 * Renders the known store context as human-readable markdown.
 * No JSON arrays. Files as code fences. Knowledge as bullet lists.
 */
function renderContext(context) {
	const files = [];
	const symbolFiles = [];
	const storedFiles = [];
	const activeKnown = [];
	const storedKnown = [];
	const results = [];
	const unknowns = [];
	let prompt = null;

	for (const entry of context) {
		if (entry.state === "prompt") { prompt = entry; continue; }
		if (entry.state === "unknown") { unknowns.push(entry); continue; }
		if (entry.state === "file") { files.push(entry); continue; }
		if (entry.state === "file:readonly") { files.push(entry); continue; }
		if (entry.state === "file:active") { files.push(entry); continue; }
		if (entry.state === "file:symbols") { symbolFiles.push(entry); continue; }
		if (entry.state === "file:path") { storedFiles.push(entry); continue; }
		if (entry.state === "full") { activeKnown.push(entry); continue; }
		if (entry.state === "stored") { storedKnown.push(entry); continue; }
		// Results (pass, warn, error, summary, info)
		results.push(entry);
	}

	const parts = [];

	// Files with content
	if (files.length > 0) {
		const fileBlocks = files.map((f) => {
			const lang = langFor(f.key);
			const tokens = f.tokens ? ` (${f.tokens} tokens)` : "";
			const label = f.state !== "file" ? ` (${f.state.replace("file:", "")})` : "";
			return `#### ${f.key}${tokens}${label}\n\`\`\`${lang}\n${f.value}\n\`\`\``;
		});
		parts.push(`### Files\n\n${fileBlocks.join("\n\n")}`);
	}

	// Symbol files
	if (symbolFiles.length > 0) {
		const symBlocks = symbolFiles.map((f) => `#### ${f.key} (symbols)\n${f.value}`);
		parts.push(symBlocks.join("\n\n"));
	}

	// Stored file paths
	if (storedFiles.length > 0) {
		parts.push(`### File Index\n${storedFiles.map((f) => f.key).join(", ")}`);
	}

	// Active knowledge
	if (activeKnown.length > 0) {
		const lines = activeKnown.map((k) => `* ${k.key} — ${k.value}`);
		parts.push(`### Knowledge\n${lines.join("\n")}`);
	}

	// Stored knowledge
	if (storedKnown.length > 0) {
		parts.push(`### Stored\n${storedKnown.map((k) => k.key).join(", ")}`);
	}

	// Results / history
	if (results.length > 0) {
		const lines = results.map((r) => {
			const check = r.state === "pass" || r.state === "summary" ? "✓"
				: r.state === "warn" ? "✗"
				: r.state === "error" ? "✗"
				: "·";
			if (r.state === "summary") return `* summary: ${r.value}`;
			const tool = r.tool || r.key.split("/")[1]?.replace(":", "") || "?";
			const target = r.target || "";
			const detail = r.value ? ` — ${r.value.slice(0, 120)}` : "";
			return `* ${tool} ${target} ${check}${detail}`;
		});
		parts.push(`### History\n${lines.join("\n")}`);
	}

	// Unknowns
	if (unknowns.length > 0) {
		const lines = unknowns.map((u) => `* ${u.value}`);
		parts.push(`### Unknowns\n${lines.join("\n")}`);
	}

	// Prompt
	if (prompt) {
		parts.push(`### Prompt\n${prompt.value}`);
	}

	return parts.length > 0 ? `## Context\n\n${parts.join("\n\n")}` : "";
}

export default class ContextAssembler {
	static assemble({ systemPrompt, mode, context, userMessage }) {
		const sections = [systemPrompt];

		// Tool schemas
		const tools = mode === "act" ? ToolSchema.act : ToolSchema.ask;
		const schemaLines = tools.map((t) => {
			const fn = t.function;
			return `### ${fn.name}\n\`\`\`json\n${JSON.stringify(fn.parameters, null, 2)}\n\`\`\``;
		});
		sections.push(`## Tool Schemas\n\n${schemaLines.join("\n\n")}`);

		// Context as markdown
		const rendered = renderContext(context);
		if (rendered) sections.push(rendered);

		const messages = [{ role: "system", content: sections.join("\n\n") }];

		// User message only if no prompt in context
		const hasPrompt = context.some((e) => e.state === "prompt");
		if (!hasPrompt && userMessage) {
			messages.push({ role: "user", content: userMessage });
		}

		return messages;
	}
}
