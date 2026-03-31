import { extname } from "node:path";

export const deterministic = true;

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

export default function (path) {
	if (!path) return "";
	return EXT_LANG[extname(path)] || "";
}
