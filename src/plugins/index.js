import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Dynamically loads and registers plugins from provided directories.
 */
export async function registerPlugins(dirs = [], hooks) {
	const uniqueDirs = [...new Set(dirs.map((d) => join(d)))];

	for (const dir of uniqueDirs) {
		await scanDir(dir, hooks, true); // Root level
	}
}

async function scanDir(dir, hooks, isRoot = false) {
	if (!existsSync(dir)) return;

	const dirStats = statSync(dir);
	if (!dirStats.isDirectory()) {
		if (process.env.SNORE_DEBUG === "true") {
			console.error(
				`[SNORE] Cannot scan plugin directory (not a directory): ${dir}`,
			);
		}
		return;
	}

	let entries;
	try {
		entries = readdirSync(dir);
	} catch (err) {
		if (process.env.SNORE_DEBUG === "true") {
			console.error(`[SNORE] Failed to read directory ${dir}:`, err.message);
		}
		return;
	}

	for (const name of entries) {
		if (name.endsWith(".test.js")) continue;

		const fullPath = join(dir, name);
		let stats;
		try {
			stats = statSync(fullPath);
		} catch (_err) {
			continue;
		}

		if (stats.isFile() && name.endsWith(".js")) {
			// Always load any .js file that is not index.js (unless we want index.js)
			// Wait: to maintain original intent of 'index.js as folder entry point'
			if (name === "index.js" || name === `${basename(dir)}.js`) {
				await loadPlugin(fullPath, hooks);
			} else if (isRoot) {
				// At root level, load all files except index.js
				if (name !== "index.js") await loadPlugin(fullPath, hooks);
			} else {
				// In a subfolder, and it's not the entry point file. 
				// We don't load random .js files deep in subfolders unless they follow the naming convention.
				// This prevents loading tests or helpers.
				// However, if we want to allow deep organization like findings/findings.js:
				if (name === `${basename(dir)}.js`) {
					await loadPlugin(fullPath, hooks);
				}
			}
		} else if (stats.isDirectory()) {
			await scanDir(fullPath, hooks, false);
		}
	}
}

async function loadPlugin(filePath, hooks) {
	try {
		const url = pathToFileURL(filePath).href;
		const { default: Plugin } = await import(url);
		if (typeof Plugin?.register === "function") {
			Plugin.register(hooks);
		} else {
			if (process.env.SNORE_DEBUG === "true") {
				console.error(
					`[SNORE] Plugin at ${filePath} has no register() method.`,
				);
			}
		}
	} catch (err) {
		if (process.env.SNORE_DEBUG === "true") {
			console.error(`[SNORE] Plugin load failed at ${filePath}:`, err);
		}
	}
}
