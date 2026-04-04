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

const FIDELITY_ORDER = { index: 0, summary: 1, full: 2 };

export default class ContextAssembler {
	static assembleFromTurnContext(
		rows,
		{ type = "ask", tools = "", systemPrompt = "" } = {},
	) {
		// --- Classify rows ---

		// Knowledge (system <knowledge>): files, known, stored, index
		const knowledge = [];

		// Unknowns (system <unknowns>)
		const unknowns = [];

		// Find the active prompt and loop boundary
		let activePrompt = null;
		let activeMode = null;
		let loopStartTurn = 0;

		// History entries (result, structural, prompt, assistant responses)
		const history = [];

		// Progress entry
		let progressBody = null;

		for (const row of rows) {
			const attrs = row.attributes ? JSON.parse(row.attributes) : null;

			switch (row.category) {
				case "file":
				case "file_index":
				case "known":
				case "known_index":
					knowledge.push({
						path: row.path,
						body: row.body,
						tokens: row.tokens,
						state: row.state,
						fidelity: row.fidelity,
						category: row.category,
						constraint: attrs?.constraint,
					});
					break;

				case "unknown":
					unknowns.push({ body: row.body });
					break;

				case "prompt":
					if (row.scheme === "ask" || row.scheme === "act") {
						activePrompt = row.body;
						activeMode = row.scheme;
						loopStartTurn = row.source_turn;
					} else if (row.scheme === "progress") {
						progressBody = row.body;
					}
					break;

				case "result":
				case "structural":
					history.push({
						path: row.path,
						scheme: row.scheme,
						body: row.body,
						state: row.state,
						source_turn: row.source_turn,
						tool: row.scheme,
						target:
							attrs?.command ||
							attrs?.file ||
							attrs?.path ||
							attrs?.question ||
							"",
					});
					break;
			}
		}

		// --- System message ---
		const systemParts = [systemPrompt];

		// <knowledge>: sorted by fidelity (index, summary, full), then scheme
		if (knowledge.length > 0) {
			knowledge.sort((a, b) => {
				const fa = FIDELITY_ORDER[a.fidelity] ?? 0;
				const fb = FIDELITY_ORDER[b.fidelity] ?? 0;
				if (fa !== fb) return fa - fb;
				const sa = a.category;
				const sb = b.category;
				if (sa < sb) return -1;
				if (sa > sb) return 1;
				return 0;
			});
			const knowledgeLines = knowledge.map((k) => renderKnowledgeEntry(k));
			systemParts.push(
				`<knowledge>\n${knowledgeLines.join("\n")}\n</knowledge>`,
			);
		}

		// <previous>: completed loop history (before current loop)
		const previousEntries = history.filter(
			(e) => loopStartTurn > 0 && e.source_turn < loopStartTurn,
		);
		if (previousEntries.length > 0) {
			const lines = previousEntries.map(renderHistoryEntry);
			systemParts.push(`<previous>\n${lines.join("\n")}\n</previous>`);
		}

		// <unknowns>
		if (unknowns.length > 0) {
			const lines = unknowns.map((u) => `* ${u.body}`);
			systemParts.push(`<unknowns>\n${lines.join("\n")}\n</unknowns>`);
		}

		const messages = [{ role: "system", content: systemParts.join("\n\n") }];

		// --- User message ---
		const userParts = [];

		// <current>: active loop history (minus the active prompt)
		const currentEntries = history.filter(
			(e) => e.source_turn >= loopStartTurn,
		);
		if (currentEntries.length > 0) {
			const lines = currentEntries.map(renderHistoryEntry);
			userParts.push(`<current>\n${lines.join("\n")}\n</current>`);
		}

		// <progress>
		const effectiveMode = activeMode || type;
		const warn =
			effectiveMode === "ask"
				? ' warn="File and system modification prohibited on this turn."'
				: "";

		const progressText =
			progressBody ||
			(currentEntries.length > 0
				? "The above actions have been performed in response to the following prompt:"
				: "Begin.");
		userParts.push(`<progress>${progressText}</progress>`);

		// <ask> or <act> — always present
		const promptBody = activePrompt || "";
		userParts.push(
			`<${effectiveMode} tools="${tools}"${warn}>${promptBody}</${effectiveMode}>`,
		);

		messages.push({
			role: "user",
			content: userParts.join("\n"),
		});

		return messages;
	}
}

function renderKnowledgeEntry(entry) {
	switch (entry.category) {
		case "file_index":
		case "known_index":
			return entry.path;
		case "known":
			return `* ${entry.path} — ${entry.body}`;
		case "file": {
			const lang = langFor(entry.path);
			const tokens = entry.tokens ? ` (${entry.tokens} tokens)` : "";
			const label =
				entry.constraint === "readonly"
					? " (readonly)"
					: entry.constraint === "active"
						? " (active)"
						: "";
			return `#### ${entry.path}${tokens}${label}\n\`\`\`${lang}\n${entry.body}\n\`\`\``;
		}
		default:
			return `* ${entry.path} — ${entry.body}`;
	}
}

function renderHistoryEntry(entry) {
	if (entry.scheme === "ask") return `> [ask] ${entry.body}`;
	if (entry.scheme === "act") return `> [act] ${entry.body}`;
	if (entry.scheme === "summarize") return `* summary: ${entry.body}`;
	if (entry.scheme === "update") return `* update: ${entry.body}`;

	const check =
		entry.state === "pass" || entry.state === "summary"
			? "✓"
			: entry.state === "rejected" || entry.state === "error"
				? "✗"
				: "·";
	const tool = entry.tool || entry.path.match(/^(\w+):\/\//)?.[1] || "?";
	const target = entry.target || "";
	const detail = entry.body ? ` — ${entry.body.slice(0, 120)}` : "";
	return `* ${tool} ${target} ${check}${detail}`;
}
