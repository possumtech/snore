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

export default class ContextAssembler {
	static assembleFromTurnContext(
		rows,
		{ type = "ask", tools = "", systemPrompt = "" } = {},
	) {
		const instructions = systemPrompt;
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
		let promptMode = null;
		let promptOrdinal = -1;
		let continuationOrdinal = -1;

		for (const row of rows) {
			if (row.scheme === "progress") {
				continuation = row.body;
				continuationOrdinal = row.ordinal;
			}

			const attrs = row.attributes ? JSON.parse(row.attributes) : null;

			switch (row.category) {
				case "file": {
					const constraint = attrs?.constraint;
					const label =
						constraint === "readonly"
							? "file:readonly"
							: constraint === "active"
								? "file:active"
								: "file";
					files.push({
						path: row.path,
						body: row.body,
						tokens: row.tokens,
						state: label,
					});
					break;
				}
				case "file_summary":
					symbolFiles.push({ path: row.path, body: row.body });
					break;
				case "file_index":
					storedFiles.push({ path: row.path });
					break;
				case "known":
					activeKnown.push({ path: row.path, body: row.body });
					break;
				case "known_index":
					storedKnown.push({ path: row.path });
					break;
				case "unknown":
					unknowns.push({ body: row.body });
					break;
				case "prompt":
					if (row.scheme === "ask" || row.scheme === "act") {
						prompt = row.body;
						promptMode = row.scheme;
						promptOrdinal = row.ordinal;
					} else if (row.scheme === "progress") {
						messageEntries.push({
							path: row.path,
							scheme: row.scheme,
							body: row.body,
						});
					}
					break;
				case "result":
					messageEntries.push({
						path: row.path,
						body: row.body,
						tool: row.scheme,
						target:
							attrs?.command ||
							attrs?.file ||
							attrs?.path ||
							attrs?.question ||
							"",
						state: row.state,
					});
					break;
				case "structural":
					messageEntries.push({
						path: row.path,
						scheme: row.scheme,
						body: row.body,
						state: row.scheme === "summarize" ? "summary" : "info",
					});
					break;
			}
		}

		// --- System message: instructions + context ---
		const contextParts = [];

		if (activeKnown.length > 0) {
			const lines = activeKnown.map((k) => `* ${k.path} — ${k.body}`);
			contextParts.push(`### Knowledge\n${lines.join("\n")}`);
		}

		if (storedKnown.length > 0) {
			contextParts.push(
				`### Stored\n${storedKnown.map((k) => k.path).join(", ")}`,
			);
		}

		if (storedFiles.length > 0) {
			contextParts.push(
				`### Index\n${storedFiles.map((f) => f.path).join(", ")}`,
			);
		}

		if (symbolFiles.length > 0) {
			const symBlocks = symbolFiles.map(
				(f) => `#### ${f.path} (summary)\n${f.body}`,
			);
			contextParts.push(symBlocks.join("\n\n"));
		}

		if (files.length > 0) {
			const fileBlocks = files.map((f) => {
				const lang = langFor(f.path);
				const tokens = f.tokens ? ` (${f.tokens} tokens)` : "";
				const label =
					f.state !== "file" ? ` (${f.state.replace("file:", "")})` : "";
				return `#### ${f.path}${tokens}${label}\n\`\`\`${lang}\n${f.body}\n\`\`\``;
			});
			contextParts.push(`### Files\n\n${fileBlocks.join("\n\n")}`);
		}

		if (unknowns.length > 0) {
			const lines = unknowns.map((u) => `* ${u.body}`);
			contextParts.push(`### Unknowns\n${lines.join("\n")}`);
		}

		const systemParts = [instructions];
		if (contextParts.length > 0) {
			systemParts.push(`<context>\n${contextParts.join("\n\n")}\n</context>`);
		}

		const messages = [{ role: "system", content: systemParts.join("\n\n") }];

		// --- User message: messages + prompt/progress ---
		const userParts = [];

		if (messageEntries.length > 0) {
			const lines = messageEntries.map((e) => {
				if (e.scheme === "ask") return `> [ask] ${e.body}`;
				if (e.scheme === "act") return `> [act] ${e.body}`;
				if (e.scheme === "progress") return `> [continuation] ${e.body}`;
				const check =
					e.state === "pass" || e.state === "summary"
						? "✓"
						: e.state === "rejected" || e.state === "error"
							? "✗"
							: "·";
				if (e.state === "summary") return `* summary: ${e.body}`;
				const tool = e.tool || e.path.match(/^(\w+):\/\//)?.[1] || "?";
				const target = e.target || "";
				const detail = e.body ? ` — ${e.body.slice(0, 120)}` : "";
				return `* ${tool} ${target} ${check}${detail}`;
			});
			userParts.push(`<messages>\n${lines.join("\n")}\n</messages>`);
		}

		const effectiveMode = promptMode || type;
		const warn =
			effectiveMode === "ask"
				? ' warn="File and system modification prohibited on this turn."'
				: "";
		const injected =
			prompt && continuation && promptOrdinal > continuationOrdinal;
		if (injected) {
			userParts.push(
				`<${promptMode} tools="${tools}"${warn}>${prompt}</${promptMode}>`,
			);
		} else if (continuation) {
			userParts.push(
				`<progress tools="${tools}"${warn}>${continuation}</progress>`,
			);
		} else if (prompt && promptMode) {
			userParts.push(
				`<${promptMode} tools="${tools}"${warn}>${prompt}</${promptMode}>`,
			);
		}

		messages.push({
			role: "user",
			content: userParts.length > 0 ? userParts.join("\n") : "Begin.",
		});

		return messages;
	}
}
