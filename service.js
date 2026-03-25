import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Helper to expand ~ in paths since node --env-file doesn't do it
function expandPath(path) {
	if (!path) return path;
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	if (path === "~") return homedir();
	return path;
}

// 0. Pre-flight Check: Environment and Dependencies
const rummyHome = expandPath(process.env.RUMMY_HOME);
const defaultModel = process.env.RUMMY_MODEL_DEFAULT;

if (!rummyHome) {
	console.error("RUMMY Configuration Error: RUMMY_HOME is not defined in environment.");
	process.exit(1);
}

if (!defaultModel) {
	console.error("RUMMY Configuration Error: RUMMY_MODEL_DEFAULT is not defined.");
	process.exit(1);
}

// Resolve the actual model ID (handles aliases like RUMMY_MODEL_ccp=...)
const actualModelId = process.env[`RUMMY_MODEL_${defaultModel}`] || defaultModel;

// Check for Universal Ctags (Optional but Recommended)
const ctagsCheck = spawnSync("ctags", ["--version"]);
if (ctagsCheck.error || ctagsCheck.status !== 0) {
	console.warn("\n[RUMMY] WARNING: 'universal-ctags' not found in PATH.");
	console.warn(
		"        Repository Mapping quality will be significantly reduced.",
	);
	console.warn("        Please install it: https://ctags.io/\n");
}

// Check if we need an API key (OpenRouter models) or OLLAMA_BASE_URL
if (actualModelId.startsWith("ollama/")) {
	if (!process.env.OLLAMA_BASE_URL) {
		console.error("RUMMY Configuration Error:");
		console.error(`- Model '${defaultModel}' (${actualModelId}) requires OLLAMA_BASE_URL.`);
		console.error("\nPlease check your .env file.");
		process.exit(1);
	}
} else if (!process.env.OPENROUTER_API_KEY) {
	console.error("RUMMY Configuration Error:");
	console.error(`- Model '${defaultModel}' (${actualModelId}) requires OPENROUTER_API_KEY.`);
	console.error("\nPlease check your .env file or use an 'ollama/' prefixed model.");
	process.exit(1);
}

let SqlRite, SocketServer, registerPlugins, createHooks;
try {
	SqlRite = (await import("@possumtech/sqlrite")).default;
	SocketServer = (await import("./src/infrastructure/socket/SocketServer.js")).default;
	registerPlugins = (await import("./src/plugins/index.js")).registerPlugins;
	createHooks = (await import("./src/domain/hooks/Hooks.js")).default;
} catch (err) {
	if (err.code === "ERR_MODULE_NOT_FOUND") {
		console.error("RUMMY Dependency Error: node_modules not found or incomplete.");
		console.error("Please run: npm install");
		process.exit(1);
	}
	throw err;
}

async function main() {
	// 1. Initialize Hooks (Agnostic Engine)
	const debug = process.env.RUMMY_DEBUG === "true";
	const hooks = createHooks(debug);

	// 2. Resolve Directories
	const userPluginsDir = join(rummyHome, "plugins");
	const internalPluginsDir = fileURLToPath(new URL("./src/application/plugins", import.meta.url));
	const corePluginsDir = fileURLToPath(new URL("./src/plugins", import.meta.url));

	// 3. Ensure Directory Structure
	mkdirSync(userPluginsDir, { recursive: true });

	// 4. Register Plugins
	await registerPlugins([internalPluginsDir, corePluginsDir, userPluginsDir], hooks);

	// 5. Bootstrap Persistence
	const dbPath = process.env.RUMMY_DB_PATH || join(rummyHome, "rummy.db");
	const db = await SqlRite.open({
		path: dbPath,
		dir: ["migrations", "src"],
	});

	// 6. Database Hygiene (run on startup)
	const { statSync } = await import("node:fs");
	try {
		const dbSizeBefore = statSync(dbPath).size;
		await db.purge_old_runs();
		await db.purge_stale_sessions();
		await db.purge_consumed_context();
		const dbSizeAfter = statSync(dbPath).size;
		const dbSizeMB = (dbSizeAfter / 1024 / 1024).toFixed(2);
		const freed = dbSizeBefore - dbSizeAfter;
		if (freed > 0) {
			console.log(`[RUMMY] Hygiene: freed ${(freed / 1024).toFixed(1)}KB, DB is ${dbSizeMB}MB`);
		} else {
			console.log(`[RUMMY] DB size: ${dbSizeMB}MB`);
		}
		if (dbSizeAfter > 100 * 1024 * 1024) {
			console.warn(`[RUMMY] WARNING: Database exceeds 100MB. Consider manual cleanup.`);
		}
	} catch (err) {
		console.warn(`[RUMMY] Hygiene skipped: ${err.message}`);
	}

	// 7. Start RPC Server
	const port = Number.parseInt(process.env.PORT);
	const server = new SocketServer(db, { port, hooks });

	server.on("error", (err) => {
		if (err.code === "EADDRINUSE") {
			console.error(`RUMMY Critical: Port ${port} is already in use.`);
			process.exit(1);
		}
		throw err;
	});

	console.log(`RUMMY Service Operational`);
	console.log(`- Home: ${rummyHome}`);
	console.log(`- DB:   ${dbPath}`);
	console.log(`- Port: ${port}`);
}

main().catch((err) => {
	console.error("RUMMY Failed to boot:", err.message);
	process.exit(1);
});
