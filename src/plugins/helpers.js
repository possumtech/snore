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

export function langFor(filePath) {
	return EXT_LANG[extname(filePath)] || "";
}

export const FIDELITY_ORDER = { index: 0, summary: 1, full: 2 };

export function renderHistoryEntry(entry) {
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

/**
 * Shared helper for pattern-based tool results.
 * Used by read, write, store, and delete tools.
 */
export async function storePatternResult(
	store,
	runId,
	turn,
	scheme,
	path,
	bodyFilter,
	matches,
	preview = false,
) {
	const slug = await store.slugPath(runId, scheme, path);
	const filter = bodyFilter ? ` body="${bodyFilter}"` : "";
	const total = matches.reduce((s, m) => s + m.tokens_full, 0);
	const listing = matches.map((m) => `${m.path} (${m.tokens_full})`).join("\n");
	const prefix = preview ? "PREVIEW " : "";
	const body = `${prefix}${scheme} path="${path}"${filter}: ${matches.length} matched (${total} tokens)\n${listing}`;
	await store.upsert(runId, turn, slug, body, "pattern");
}
