import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import PluginContext from "../hooks/PluginContext.js";

let globalPrefix;
function getGlobalPrefix() {
	globalPrefix ??= execSync("npm prefix -g", { encoding: "utf8" }).trim();
	return globalPrefix;
}

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

const AUDIT_SCHEMES = [
	"instructions",
	"system",
	"prompt",
	"ask",
	"act",
	"progress",
	"reasoning",
	"model",
	"error",
	"user",
	"assistant",
	"content",
];

/**
 * After DB is ready, inject db and store into all PluginContext instances,
 * upsert declared schemes, and bootstrap audit schemes.
 */
export async function initPlugins(db, store, hooks) {
	for (const name of AUDIT_SCHEMES) {
		const scheme = {
			name,
			fidelity: ["ask", "act", "progress"].includes(name) ? "full" : "null",
			model_visible: ["ask", "act", "progress"].includes(name) ? 1 : 0,
			valid_states: JSON.stringify(["info"]),
			category: "audit",
		};
		await db.upsert_scheme.run(scheme);
	}

	for (const ctx of instances.values()) {
		ctx.db = db;
		ctx.entries = store;
		for (const scheme of ctx.schemes) {
			await db.upsert_scheme.run(scheme);
		}
	}

	// Register default schemes for tools that plugins ensured but didn't registerScheme for
	if (hooks) {
		const registered = new Set();
		for (const ctx of instances.values()) {
			for (const s of ctx.schemes) registered.add(s.name);
		}
		for (const name of AUDIT_SCHEMES) registered.add(name);

		for (const toolName of hooks.tools.names) {
			if (registered.has(toolName)) continue;
			await db.upsert_scheme.run({
				name: toolName,
				fidelity: "full",
				model_visible: 1,
				valid_states: JSON.stringify([
					"full",
					"proposed",
					"pass",
					"rejected",
					"error",
					"info",
				]),
				category: "result",
			});
		}
	}
}

function resolvePlugin(packageName) {
	// Check local node_modules first, then global
	const localDir = join(process.cwd(), "node_modules", packageName);
	if (existsSync(join(localDir, "package.json"))) return localDir;
	const globalDir = join(getGlobalPrefix(), "lib", "node_modules", packageName);
	if (existsSync(join(globalDir, "package.json"))) return globalDir;
	throw new Error(`Package '${packageName}' not found locally or globally`);
}

async function importPlugin(packageName) {
	const dir = resolvePlugin(packageName);
	const pkg = JSON.parse(
		(await import("node:fs")).readFileSync(join(dir, "package.json"), "utf8"),
	);
	const entry = pkg.exports?.["."] || pkg.main || "index.js";
	return import(pathToFileURL(join(dir, entry)).href);
}

async function loadEnvPlugins(hooks) {
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("RUMMY_PLUGIN_") || !value) continue;
		const name = key.replace("RUMMY_PLUGIN_", "").toLowerCase();
		try {
			const { default: Plugin } = await importPlugin(value);
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
