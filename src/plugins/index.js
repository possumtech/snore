import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
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
	"reasoning",
	"model",
	"error",
	"user",
	"assistant",
	"content",
];

const PROMPT_SCHEMES = ["prompt", "progress"];

/**
 * After DB is ready, inject db and store into all PluginContext instances,
 * upsert declared schemes, and bootstrap audit schemes.
 */
export async function initPlugins(db, store, hooks) {
	for (const name of AUDIT_SCHEMES) {
		await db.upsert_scheme.run({
			name,
			model_visible: 0,
			category: "audit",
		});
	}
	for (const name of PROMPT_SCHEMES) {
		await db.upsert_scheme.run({
			name,
			model_visible: 1,
			category: "prompt",
		});
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
		for (const name of PROMPT_SCHEMES) registered.add(name);

		for (const toolName of hooks.tools.names) {
			if (registered.has(toolName)) continue;
			await db.upsert_scheme.run({
				name: toolName,
				model_visible: 1,
				category: "logging",
			});
		}
	}

	if (store) store.loadSchemes(db);
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
			const importPromise = isAbsolute(value)
				? importAbsolute(value)
				: importPlugin(value);
			const { default: Plugin } = await withTimeout(
				importPromise,
				PLUGIN_LOAD_TIMEOUT,
				`Plugin import timed out: ${value}`,
			);
			if (typeof Plugin?.register === "function") {
				await withTimeout(
					Plugin.register(hooks),
					PLUGIN_LOAD_TIMEOUT,
					`Plugin register timed out: ${value}`,
				);
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

async function importAbsolute(dir) {
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) {
		// Bare .js file
		return import(pathToFileURL(dir).href);
	}
	const pkg = JSON.parse(
		(await import("node:fs")).readFileSync(pkgPath, "utf8"),
	);
	const entry = pkg.exports?.["."] || pkg.main || "index.js";
	return import(pathToFileURL(join(dir, entry)).href);
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
			if (existsSync(join(fullPath, "DISABLED"))) continue;
			await scanDir(fullPath, hooks, false);
		}
	}
}

const PLUGIN_LOAD_TIMEOUT = 10000;

async function loadPlugin(filePath, hooks) {
	try {
		const url = pathToFileURL(filePath).href;
		const { default: Plugin } = await withTimeout(
			import(url),
			PLUGIN_LOAD_TIMEOUT,
			`Plugin import timed out: ${filePath}`,
		);

		if (typeof Plugin?.register === "function") {
			await withTimeout(
				Plugin.register(hooks),
				PLUGIN_LOAD_TIMEOUT,
				`Plugin register timed out: ${filePath}`,
			);
		} else if (typeof Plugin === "function") {
			const name = basename(filePath, ".js");
			const ctx = new PluginContext(name, hooks);
			const _instance = new Plugin(ctx);
			instances.set(name, ctx);
		}
	} catch (err) {
		console.warn(
			`[RUMMY] Plugin load failed: ${basename(filePath)} — ${err.message}`,
		);
	}
}

function withTimeout(promise, ms, message) {
	return Promise.race([
		promise,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(message)), ms),
		),
	]);
}
