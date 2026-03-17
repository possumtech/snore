import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
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

	let dirStats;
	try {
		dirStats = await stat(dir);
	} catch (_err) {
		return;
	}

	if (!dirStats.isDirectory()) {
		if (process.env.RUMMY_DEBUG === "true") {
			console.error(
				`[RUMMY] Cannot scan plugin directory (not a directory): ${dir}`,
			);
		}
		return;
	}

	let entries;
	try {
		entries = await readdir(dir);
	} catch (err) {
		if (process.env.RUMMY_DEBUG === "true") {
			console.error(`[RUMMY] Failed to read directory ${dir}:`, err.message);
		}
		return;
	}

	for (const name of entries) {
		if (name.endsWith(".test.js")) continue;

		const fullPath = join(dir, name);
		let stats;
		try {
			stats = await stat(fullPath);
		} catch (_err) {
			continue;
		}

		if (stats.isFile() && name.endsWith(".js")) {
			if (name === "index.js" || name === `${basename(dir)}.js`) {
				await loadPlugin(fullPath, hooks);
			} else if (isRoot && name !== "index.js") {
				await loadPlugin(fullPath, hooks);
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
			if (process.env.RUMMY_DEBUG === "true") {
				console.error(
					`[RUMMY] Plugin at ${filePath} has no register() method.`,
				);
			}
		}
	} catch (err) {
		if (process.env.RUMMY_DEBUG === "true") {
			console.error(`[RUMMY] Plugin load failed at ${filePath}:`, err);
		}
	}
}
