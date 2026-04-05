import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import PluginContext from "../hooks/PluginContext.js";

const instances = new Map();

/**
 * Dynamically loads and registers plugins from provided directories
 * and RUMMY_PLUGIN_* env vars.
 */
export async function registerPlugins(dirs = [], hooks) {
	const uniqueDirs = [...new Set(dirs.map((d) => join(d)))];

	for (const dir of uniqueDirs) {
		await scanDir(dir, hooks, true);
	}

	await loadEnvPlugins(hooks);
}

/**
 * After DB is ready, inject db and store into all PluginContext instances.
 */
export function initPlugins(db, store) {
	for (const ctx of instances.values()) {
		ctx.db = db;
		ctx.entries = store;
	}
}

async function loadEnvPlugins(hooks) {
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("RUMMY_PLUGIN_") || !value) continue;
		const name = key.replace("RUMMY_PLUGIN_", "").toLowerCase();
		try {
			const { default: Plugin } = await import(value);
			if (typeof Plugin?.register === "function") {
				await Plugin.register(hooks);
			} else if (typeof Plugin === "function") {
				const ctx = new PluginContext(name, hooks);
				new Plugin(ctx);
				instances.set(name, ctx);
			}
			console.log(`[RUMMY] Plugin ${name}: ${value}`);
		} catch (err) {
			console.warn(`[RUMMY] Plugin ${name} (${value}): ${err.message}`);
		}
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
			await Plugin.register(hooks);
		} else if (typeof Plugin === "function") {
			const name = basename(filePath, ".js");
			const ctx = new PluginContext(name, hooks);
			const _instance = new Plugin(ctx);
			instances.set(name, ctx);
		}
	} catch (err) {
		if (process.env.RUMMY_DEBUG === "true") {
			console.error(`[RUMMY] Plugin load failed at ${filePath}:`, err);
		}
	}
}
