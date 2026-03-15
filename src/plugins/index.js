import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import HookRegistry from "../core/HookRegistry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Dynamically loads and registers plugins from provided directories.
 */
export async function registerPlugins(dirs = []) {
	const hooks = HookRegistry.instance;
	const internalDir = join(__dirname, "..", "internal");
	const scanDirs = [internalDir, ...dirs];

	for (const dir of scanDirs) {
		await scanAndLoad(dir, hooks);
	}
}

async function scanAndLoad(dir, hooks) {
	if (!existsSync(dir)) return;

	const entries = readdirSync(dir);
	for (const name of entries) {
		const fullPath = join(dir, name);
		const stats = statSync(fullPath);

		if (stats.isFile() && name.endsWith(".js") && name !== "index.js") {
			// Load root-level files
			await loadPlugin(fullPath, hooks);
		} else if (stats.isDirectory()) {
			// Check for FolderName.js or index.js
			const namedJs = join(fullPath, `${name}.js`);
			const indexJs = join(fullPath, "index.js");

			if (existsSync(namedJs)) {
				await loadPlugin(namedJs, hooks);
			} else if (existsSync(indexJs)) {
				await loadPlugin(indexJs, hooks);
			} else {
				// Recursive scan for nested folders (e.g. internal/git/GitPlugin.js)
				await scanAndLoad(fullPath, hooks);
			}
		}
	}
}

async function loadPlugin(filePath, hooks) {
	try {
		const url = pathToFileURL(filePath).href;
		const { default: Plugin } = await import(url);
		if (typeof Plugin?.register === "function") {
			Plugin.register(hooks);
		}
	} catch (err) {
		// Suppress errors during bulk loading unless they are syntax errors
		if (process.env.SNORE_DEBUG === "true") {
			console.error(`[SNORE] Plugin load failed at ${filePath}:`, err.message);
		}
	}
}
