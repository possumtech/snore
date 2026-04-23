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

/**
 * Plugin loader:
 *   1. Walk filesystem + env vars to collect plugin descriptors.
 *   2. Import each and instantiate with a fresh PluginContext.
 *
 * Returns a Map of name → PluginContext for the caller to pass to
 * initPlugins. No module-global state — each caller owns its set.
 *
 * Plugin constructors must be declarative (SPEC surfaces): they
 * register schemes, hooks, filters, RPC methods — but don't dereference
 * infrastructure that might not be ready yet. Because the plugin
 * contract makes constructors side-effect-free on each other, load
 * order doesn't matter and there is no dependency system.
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
			resolved.push({ ...d, Plugin: module.default });
		} catch (err) {
			console.warn(`[RUMMY] Plugin import failed: ${d.name} — ${err.message}`);
		}
	}

	const instances = new Map();
	for (const r of resolved) {
		try {
			await instantiatePlugin(r, hooks, instances);
		} catch (err) {
			console.warn(`[RUMMY] Plugin load failed: ${r.name} — ${err.message}`);
		}
	}
	return instances;
}

async function instantiatePlugin({ name, Plugin, source }, hooks, instances) {
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

// Lifecycle schemes: client-addressable entries that reflect server
// state. Writable by system (internal bookkeeping), plugin (extensions),
// and client (RPC in Phase 4).
const LIFECYCLE_SCHEMES = ["run"];

// Unified log namespace for action history entries under
// log://turn_N/scheme/slug.
const LOG_SCHEMES = ["log"];

/**
 * After DB is ready, upsert declared schemes and bootstrap audit/prompt
 * schemes. Takes the plugin collection returned by registerPlugins.
 * Per-plugin store/db access is provided per-turn via RummyContext;
 * PluginContext itself holds only name + hooks.
 */
export async function initPlugins(db, hooks, instances) {
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
	for (const name of LOG_SCHEMES) {
		await db.upsert_scheme.run({
			name,
			model_visible: 1,
			category: "logging",
			default_scope: "run",
			writable_by: JSON.stringify(["system", "plugin", "model"]),
		});
	}
	for (const name of LIFECYCLE_SCHEMES) {
		// Lifecycle entries are client-addressable mirrors of server state.
		// Not model-visible. System writes internally; plugins and clients
		// write via the 6 primitives.
		await db.upsert_scheme.run({
			name,
			model_visible: 0,
			category: "logging",
			default_scope: "run",
			writable_by: JSON.stringify(["system", "plugin", "client"]),
		});
	}

	for (const ctx of instances.values()) {
		for (const scheme of ctx.schemes) {
			await db.upsert_scheme.run(scheme);
		}
	}

	// Register default schemes for tools that plugins ensured but didn't registerScheme for
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

function resolvePlugin(packageName) {
	// Check local node_modules first, then global
	const localDir = join(process.cwd(), "node_modules", packageName);
	if (existsSync(join(localDir, "package.json"))) return localDir;
	const globalDir = join(getGlobalPrefix(), "lib", "node_modules", packageName);
	if (existsSync(join(globalDir, "package.json"))) return globalDir;
	throw new Error(`Package '${packageName}' not found locally or globally`);
}

async function _importPlugin(packageName) {
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
	if (!(await stat(dir)).isDirectory()) return;

	for (const name of await readdir(dir)) {
		if (name.endsWith(".test.js")) continue;

		const fullPath = join(dir, name);
		const stats = await stat(fullPath);

		if (stats.isFile() && name.endsWith(".js")) {
			const isEntryFile = name === "index.js" || name === `${basename(dir)}.js`;
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
