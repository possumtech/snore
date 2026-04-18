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
 * Two-pass plugin loader:
 *   1. Walk filesystem + env vars to collect plugin descriptors
 *      (name, import URL, Plugin class, declared dependencies).
 *   2. Topological sort by `static dependsOn = ["other-plugin"]`
 *      declarations; fail loudly on cycle or missing dependency.
 *   3. Instantiate in topological order.
 *
 * A plugin declares a dependency like:
 *   export default class MyPlugin {
 *       static dependsOn = ["instructions", "budget"];
 *       constructor(core) { ... }
 *   }
 *
 * Dependencies are soft today (no plugin currently needs another
 * plugin's `core.hooks.X` at construction time). This system exists
 * so future plugins can safely assume load order.
 */
export async function registerPlugins(dirs = [], hooks) {
	const uniqueDirs = [...new Set(dirs.map((d) => join(d)))];

	const descriptors = [];
	for (const dir of uniqueDirs) {
		await collectFromDir(dir, true, descriptors);
	}
	await collectFromEnv(descriptors);

	const resolved = [];
	for (const d of descriptors) {
		try {
			const module = await withTimeout(
				import(d.url),
				PLUGIN_LOAD_TIMEOUT,
				`Plugin import timed out: ${d.source}`,
			);
			const Plugin = module.default;
			const dependsOn = Array.isArray(Plugin?.dependsOn)
				? Plugin.dependsOn
				: [];
			resolved.push({ ...d, Plugin, dependsOn });
		} catch (err) {
			console.warn(`[RUMMY] Plugin import failed: ${d.name} — ${err.message}`);
		}
	}

	const sorted = topoSortPlugins(resolved);
	for (const r of sorted) {
		try {
			await instantiatePlugin(r, hooks);
		} catch (err) {
			console.warn(`[RUMMY] Plugin load failed: ${r.name} — ${err.message}`);
		}
	}
}

function topoSortPlugins(plugins) {
	const byName = new Map(plugins.map((p) => [p.name, p]));
	for (const p of plugins) {
		for (const dep of p.dependsOn) {
			if (!byName.has(dep)) {
				throw new Error(
					`Plugin "${p.name}" depends on "${dep}" which is not present. ` +
						`Available: ${[...byName.keys()].join(", ") || "none"}`,
				);
			}
		}
	}
	const sorted = [];
	const state = new Map(plugins.map((p) => [p.name, "pending"]));
	function visit(name, trail) {
		const s = state.get(name);
		if (s === "done") return;
		if (s === "visiting") {
			throw new Error(
				`Plugin dependency cycle: ${[...trail, name].join(" → ")}`,
			);
		}
		state.set(name, "visiting");
		const p = byName.get(name);
		for (const dep of p.dependsOn) visit(dep, [...trail, name]);
		state.set(name, "done");
		sorted.push(p);
	}
	for (const p of plugins) visit(p.name, []);
	return sorted;
}

async function instantiatePlugin({ name, Plugin, source }, hooks) {
	if (typeof Plugin?.register === "function") {
		await withTimeout(
			Plugin.register(hooks),
			PLUGIN_LOAD_TIMEOUT,
			`Plugin register timed out: ${source}`,
		);
		return;
	}
	if (typeof Plugin !== "function") return;
	const ctx = new PluginContext(name, hooks);
	new Plugin(ctx);
	instances.set(name, ctx);
	if (source.startsWith("env:")) {
		console.log(`[RUMMY] Plugin ${name}: ${source.slice(4)}`);
	}
}

const AUDIT_SCHEMES = [
	"instructions",
	"system",
	"reasoning",
	"model",
	"user",
	"assistant",
	"content",
];

const PROMPT_SCHEMES = ["prompt"];

/**
 * After DB is ready, inject db and store into all PluginContext instances,
 * upsert declared schemes, and bootstrap audit schemes.
 */
export async function initPlugins(db, store, hooks) {
	for (const name of AUDIT_SCHEMES) {
		// Audit schemes are written only by system-level code (reasoning,
		// user/assistant/model messages, etc.). Closing the door on model
		// writes and plugin writes here.
		await db.upsert_scheme.run({
			name,
			model_visible: 0,
			category: "audit",
			default_scope: "run",
			writable_by: JSON.stringify(["system"]),
		});
	}
	for (const name of PROMPT_SCHEMES) {
		// Prompt entries are created by the prompt plugin on user input;
		// model doesn't emit <set path="prompt://...">.
		await db.upsert_scheme.run({
			name,
			model_visible: 1,
			category: "prompt",
			default_scope: "run",
			writable_by: JSON.stringify(["plugin"]),
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
				default_scope: "run",
				writable_by: JSON.stringify(["model", "plugin"]),
			});
		}
	}

	if (store) await store.loadSchemes(db);
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

async function collectFromEnv(descriptors) {
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("RUMMY_PLUGIN_") || !value) continue;
		const name = key.replace("RUMMY_PLUGIN_", "").toLowerCase();
		try {
			const url = isAbsolute(value)
				? await resolveAbsoluteUrl(value)
				: await resolvePackageUrl(value);
			descriptors.push({ name, url, source: `env:${value}` });
		} catch (err) {
			console.warn(`[RUMMY] Plugin ${name} (${value}): ${err.message}`);
		}
	}
}

async function resolvePackageUrl(packageName) {
	const dir = resolvePlugin(packageName);
	const pkg = JSON.parse(
		(await import("node:fs")).readFileSync(join(dir, "package.json"), "utf8"),
	);
	const entry = pkg.exports?.["."] || pkg.main || "index.js";
	return pathToFileURL(join(dir, entry)).href;
}

async function resolveAbsoluteUrl(dir) {
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) {
		return pathToFileURL(dir).href;
	}
	const pkg = JSON.parse(
		(await import("node:fs")).readFileSync(pkgPath, "utf8"),
	);
	const entry = pkg.exports?.["."] || pkg.main || "index.js";
	return pathToFileURL(join(dir, entry)).href;
}

async function collectFromDir(dir, isRoot, descriptors) {
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
			const isEntryFile =
				name === "index.js" || name === `${basename(dir)}.js`;
			if (isEntryFile || (isRoot && name !== "index.js")) {
				descriptors.push({
					name: basename(fullPath, ".js"),
					url: pathToFileURL(fullPath).href,
					source: fullPath,
				});
			}
		} else if (stats.isDirectory()) {
			if (existsSync(join(fullPath, "DISABLED"))) continue;
			await collectFromDir(fullPath, false, descriptors);
		}
	}
}

const PLUGIN_LOAD_TIMEOUT = 10000;

function withTimeout(promise, ms, message) {
	return Promise.race([
		promise,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(message)), ms),
		),
	]);
}
