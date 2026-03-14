import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export default class FsProvider {
	/**
	 * Lists all files in a directory recursively, respecting basic ignores.
	 * @param {string} root - The absolute path to the root.
	 * @param {string} currentDir - The current directory being scanned.
	 * @param {string[]} ignores - List of directory names to ignore.
	 * @returns {string[]} - List of relative file paths.
	 */
	static listFiles(root, currentDir = root, ignores = ["node_modules", ".git", ".venv"]) {
		const files = [];
		const items = readdirSync(currentDir, { withFileTypes: true });

		for (const item of items) {
			const fullPath = join(currentDir, item.name);
			const relPath = relative(root, fullPath);

			if (item.isDirectory()) {
				if (ignores.includes(item.name)) continue;
				files.push(...FsProvider.listFiles(root, fullPath, ignores));
			} else {
				files.push(relPath);
			}
		}

		return files;
	}

	/**
	 * Gets the last modified time of a file.
	 * @param {string} fullPath - The absolute path.
	 * @returns {number} - The mtime in ms.
	 */
	static getMtime(fullPath) {
		try {
			return statSync(fullPath).mtimeMs;
		} catch {
			return 0;
		}
	}
}
