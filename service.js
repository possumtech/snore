import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Helper to expand ~ in paths since node --env-file doesn't do it
// 0. Pre-flight Check: Environment and Dependencies
const rummyHome = process.env.RUMMY_HOME;

if (!rummyHome) {
	console.error("RUMMY Configuration Error: RUMMY_HOME is not defined in environment.");
	process.exit(1);
}

// Check for optional system dependencies
const gitCheck = spawnSync("git", ["--version"]);
if (gitCheck.error || gitCheck.status !== 0) {
	console.warn("[RUMMY] WARNING: 'git' not found. File tracking will use manual activation only.");
}

let SqlRite, SocketServer, registerPlugins, createHooks, RpcRegistry;
try {
	SqlRite = (await import("@possumtech/sqlrite")).default;
	SocketServer = (await import("./src/server/SocketServer.js")).default;
	const pluginIndex = await import("./src/plugins/index.js");
	registerPlugins = pluginIndex.registerPlugins;
	var initPlugins = pluginIndex.initPlugins;
	createHooks = (await import("./src/hooks/Hooks.js")).default;
	RpcRegistry = (await import("./src/server/RpcRegistry.js")).default;
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
	hooks.rpc.registry = new RpcRegistry();

	// 2. Resolve Directories
	const userPluginsDir = join(rummyHome, "plugins");
	const pluginsDir = fileURLToPath(new URL("./src/plugins", import.meta.url));

	// 3. Ensure Directory Structure
	mkdirSync(userPluginsDir, { recursive: true });

	// 4. Register Plugins
	await registerPlugins([pluginsDir, userPluginsDir], hooks);

	// 5. Bootstrap Persistence
	const dbPath = process.env.RUMMY_DB_PATH;
	const functionsDir = fileURLToPath(new URL("./src/sql/functions", import.meta.url));
	const sqlFunctions = readdirSync(functionsDir)
		.filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
		.map((f) => join(functionsDir, f));

	const db = await SqlRite.open({
		path: dbPath,
		dir: [
			fileURLToPath(new URL("./migrations", import.meta.url)),
			fileURLToPath(new URL("./src", import.meta.url)),
		],
		functions: sqlFunctions,
		params: {
			mmap_size: Number(process.env.RUMMY_MMAP_MB) * 1024 * 1024,
		},
	});

	// 6. Initialize plugins (inject DB, register schemes)
	await initPlugins(db, null, hooks);

	// 7. Bootstrap models from env vars
	{
		const modelAliases = [];
		for (const key of Object.keys(process.env)) {
			if (!key.startsWith("RUMMY_MODEL_")) continue;
			const alias = key.replace("RUMMY_MODEL_", "");
			const actual = process.env[key];
			await db.upsert_model.get({
				alias,
				actual,
				context_length: null,
			});
			modelAliases.push(alias);
		}
		if (modelAliases.length > 0) {
			console.log(`[RUMMY] Models: ${modelAliases.join(", ")}`);
		}
	}

	// 6b. Database Hygiene
	const { statSync } = await import("node:fs");
	try {
		const dbSizeBefore = statSync(dbPath).size;
		const retentionDays = Number.parseInt(process.env.RUMMY_RETENTION_DAYS || "31", 10);
		await db.purge_old_runs.run({ retention_days: retentionDays });
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

	// 6b. Abort stuck runs (can't be running if the server just started)
	await db.reset_active_loops.run({});
	const aborted = await db.abort_stuck_runs.run({});
	if (aborted.changes > 0) {
		console.log(`[RUMMY] Recovered ${aborted.changes} stuck run(s)`);
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
