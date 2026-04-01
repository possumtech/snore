import { extname } from "node:path";

const EXT_LANG = {
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "jsx",
	".ts": "ts",
	".tsx": "tsx",
	".py": "python",
	".rb": "ruby",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".kt": "kotlin",
	".cs": "csharp",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".hpp": "cpp",
	".lua": "lua",
	".sh": "bash",
	".zsh": "bash",
	".sql": "sql",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "toml",
	".xml": "xml",
	".html": "html",
	".css": "css",
	".md": "markdown",
	".swift": "swift",
	".php": "php",
	".r": "r",
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
		if (entry.state === "prompt") {
			prompt = entry;
			continue;
		}
		if (entry.state === "unknown") {
			unknowns.push(entry);
			continue;
		}
		if (entry.state === "file") {
			files.push(entry);
			continue;
		}
		if (entry.state === "file:readonly") {
			files.push(entry);
			continue;
		}
		if (entry.state === "file:active") {
			files.push(entry);
			continue;
		}
		if (entry.state === "file:symbols") {
			symbolFiles.push(entry);
			continue;
		}
		if (entry.state === "file:path") {
			storedFiles.push(entry);
			continue;
		}
		if (entry.state === "full") {
			activeKnown.push(entry);
			continue;
		}
		if (entry.state === "stored") {
			storedKnown.push(entry);
			continue;
		}
		// Results (pass, warn, error, summary, info)
		results.push(entry);
	}

	const parts = [];

	// Files with content
	if (files.length > 0) {
		const fileBlocks = files.map((f) => {
			const lang = langFor(f.path);
			const tokens = f.tokens ? ` (${f.tokens} tokens)` : "";
			const label =
				f.state !== "file" ? ` (${f.state.replace("file:", "")})` : "";
			return `#### ${f.path}${tokens}${label}\n\`\`\`${lang}\n${f.value}\n\`\`\``;
		});
		parts.push(`### Files\n\n${fileBlocks.join("\n\n")}`);
	}

	// Symbol files
	if (symbolFiles.length > 0) {
		const symBlocks = symbolFiles.map(
			(f) => `#### ${f.path} (symbols)\n${f.value}`,
		);
		parts.push(symBlocks.join("\n\n"));
	}

	// Stored file paths
	if (storedFiles.length > 0) {
		parts.push(`### File Index\n${storedFiles.map((f) => f.path).join(", ")}`);
	}

	// Active knowledge
	if (activeKnown.length > 0) {
		const lines = activeKnown.map((k) => `* ${k.path} — ${k.value}`);
		parts.push(`### Knowledge\n${lines.join("\n")}`);
	}

	// Stored knowledge
	if (storedKnown.length > 0) {
		parts.push(`### Stored\n${storedKnown.map((k) => k.path).join(", ")}`);
	}

	// Results / history
	if (results.length > 0) {
		const lines = results.map((r) => {
			const check =
				r.state === "pass" || r.state === "summary"
					? "✓"
					: r.state === "warn"
						? "✗"
						: r.state === "error"
							? "✗"
							: "·";
			if (r.state === "summary") return `* summary: ${r.value}`;
			const tool = r.tool || r.path.match(/^(\w+):\/\//)?.[1] || "?";
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
	static assemble({ systemPrompt, context, userMessage }) {
		const sections = [systemPrompt];

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

	static assembleFromTurnContext(rows) {
		let instructions = "";
		let continuation = null;

		// Context buckets (system message)
		const files = [];
		const symbolFiles = [];
		const storedFiles = [];
		const activeKnown = [];
		const storedKnown = [];
		const unknowns = [];

		// Message buckets (user message)
		const messageEntries = [];
		let prompt = null;

		for (const row of rows) {
			if (row.path === "system://prompt") {
				instructions = row.content;
				continue;
			}
			if (row.path === "continuation://prompt") {
				continuation = row.content;
				continue;
			}

			const meta = row.meta ? JSON.parse(row.meta) : null;

			switch (row.category) {
				case "file": {
					const constraint = meta?.constraint;
					const label =
						constraint === "readonly"
							? "file:readonly"
							: constraint === "active"
								? "file:active"
								: "file";
					files.push({
						path: row.path,
						value: row.content,
						tokens: row.tokens,
						state: label,
					});
					break;
				}
				case "file_symbols":
					symbolFiles.push({ path: row.path, value: row.content });
					break;
				case "file_index":
					storedFiles.push({ path: row.path });
					break;
				case "known":
					activeKnown.push({ path: row.path, value: row.content });
					break;
				case "known_index":
					storedKnown.push({ path: row.path });
					break;
				case "unknown":
					unknowns.push({ value: row.content });
					break;
				case "prompt":
					// user:// = genuine prompt, prompt:// = continuation (goes in messages)
					if (row.scheme === "user") {
						prompt = row.content;
					}
					messageEntries.push({ path: row.path, scheme: row.scheme, value: row.content });
					break;
				case "result":
					messageEntries.push({
						path: row.path,
						value: row.content,
						tool: meta?.tool,
						target: meta?.target,
						state: meta?.state,
					});
					break;
			}
		}

		// --- System message: instructions + context ---
		const contextParts = [];

		if (activeKnown.length > 0) {
			const lines = activeKnown.map((k) => `* ${k.path} — ${k.value}`);
			contextParts.push(`### Knowledge\n${lines.join("\n")}`);
		}

		if (storedKnown.length > 0) {
			contextParts.push(
				`### Stored\n${storedKnown.map((k) => k.path).join(", ")}`,
			);
		}

		if (storedFiles.length > 0) {
			contextParts.push(
				`### File Index\n${storedFiles.map((f) => f.path).join(", ")}`,
			);
		}

		if (symbolFiles.length > 0) {
			const symBlocks = symbolFiles.map(
				(f) => `#### ${f.path} (symbols)\n${f.value}`,
			);
			contextParts.push(symBlocks.join("\n\n"));
		}

		if (files.length > 0) {
			const fileBlocks = files.map((f) => {
				const lang = langFor(f.path);
				const tokens = f.tokens ? ` (${f.tokens} tokens)` : "";
				const label =
					f.state !== "file" ? ` (${f.state.replace("file:", "")})` : "";
				return `#### ${f.path}${tokens}${label}\n\`\`\`${lang}\n${f.value}\n\`\`\``;
			});
			contextParts.push(`### Files\n\n${fileBlocks.join("\n\n")}`);
		}

		if (unknowns.length > 0) {
			const lines = unknowns.map((u) => `* ${u.value}`);
			contextParts.push(`### Unknowns\n${lines.join("\n")}`);
		}

		const systemParts = [instructions];
		if (contextParts.length > 0) {
			systemParts.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);
		}

		const messages = [
			{ role: "system", content: systemParts.join("\n\n") },
		];

		// --- User message: messages + prompt/progress ---
		const userParts = [];

		if (messageEntries.length > 0) {
			const lines = messageEntries.map((e) => {
				if (e.scheme === "user") return `> ${e.value}`;
				if (e.scheme === "prompt") return `> [continuation] ${e.value}`;
				const check =
					e.state === "pass" || e.state === "summary"
						? "✓"
						: e.state === "warn" || e.state === "error"
							? "✗"
							: "·";
				if (e.state === "summary") return `* summary: ${e.value}`;
				const tool = e.tool || e.path.match(/^(\w+):\/\//)?.[1] || "?";
				const target = e.target || "";
				const detail = e.value ? ` — ${e.value.slice(0, 120)}` : "";
				return `* ${tool} ${target} ${check}${detail}`;
			});
			userParts.push(`<messages>\n${lines.join("\n")}\n</messages>`);
		}

		if (prompt) {
			userParts.push(`<prompt>${prompt}</prompt>`);
		} else if (continuation) {
			userParts.push(`<progress>${continuation}</progress>`);
		}

		if (userParts.length > 0) {
			messages.push({ role: "user", content: userParts.join("\n") });
		}

		return messages;
	}
}
