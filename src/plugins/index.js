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

// Walk filesystem + env vars, import, instantiate; constructors must stay declarative.
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

// Lifecycle entries mirror server state; writable by system/plugin/client.
const LIFECYCLE_SCHEMES = ["run"];

const LOG_SCHEMES = ["log"];

// Bootstraps audit/prompt/log/lifecycle schemes; called after DB is ready.
export async function initPlugins(db, hooks, instances) {
	for (const name of AUDIT_SCHEMES) {
		await db.upsert_scheme.run({
			name,
			model_visible: 0,
			category: "audit",
			default_scope: "run",
			writable_by: JSON.stringify(["system"]),
		});
	}
	for (const name of PROMPT_SCHEMES) {
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

	// Default scheme for tools that ensureTool'd but didn't registerScheme.
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
