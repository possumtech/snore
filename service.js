import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// 0. Pre-flight Check: Environment and Dependencies
const rummyHome = process.env.RUMMY_HOME;

if (!rummyHome) {
	console.error("RUMMY Configuration Error: RUMMY_HOME is not defined in environment.");
	process.exit(1);
}

// 0a. Env resolution: local project config wins over RUMMY_HOME.
//
// If CWD has a rummy-shaped `.env.example` (contains any RUMMY_* var),
// this is an authoritative local config — the npm script's
// --env-file-if-exists flags already loaded it, and RUMMY_HOME would
// only pollute it with machine-wide config that doesn't belong to this
// instance.
//
// If CWD has no rummy-shaped config, fall back to
// `${RUMMY_HOME}/.env.example` (canonical defaults, shipped with the
// package) → `${RUMMY_HOME}/.env` (user overrides). On first run we
// seed the bundled .env.example into RUMMY_HOME so the user has
// something to edit.
//
// This makes multiple rummy instances on the same box cleanly
// independent: each owns its own .env.example in its CWD.
{
	const cwdExample = join(process.cwd(), ".env.example");
	const isLocalRummyConfig =
		existsSync(cwdExample) && /^\s*(#\s*)?RUMMY_\w+\s*=/m.test(readFileSync(cwdExample, "utf8"));

	if (!isLocalRummyConfig) {
		mkdirSync(rummyHome, { recursive: true });
		const homeExample = join(rummyHome, ".env.example");
		const homeEnv = join(rummyHome, ".env");
		const bundledExample = fileURLToPath(new URL("./.env.example", import.meta.url));
		if (!existsSync(homeExample) && existsSync(bundledExample)) {
			copyFileSync(bundledExample, homeExample);
			console.log(`[RUMMY] Seeded ${homeExample} from package defaults.`);
		}
		for (const path of [homeExample, homeEnv]) {
			if (!existsSync(path)) continue;
			process.loadEnvFile(path);
		}
	}
}

// Check for optional system dependencies
const gitCheck = spawnSync("git", ["--version"]);
if (gitCheck.error || gitCheck.status !== 0) {
	console.warn("[RUMMY] WARNING: 'git' not found. File tracking will use manual activation only.");
}

let SqlRite, SocketServer, registerPlugins, initPlugins, createHooks;
try {
	SqlRite = (await import("@possumtech/sqlrite")).default;
	SocketServer = (await import("./src/server/SocketServer.js")).default;
	const pluginIndex = await import("./src/plugins/index.js");
	registerPlugins = pluginIndex.registerPlugins;
	initPlugins = pluginIndex.initPlugins;
	createHooks = (await import("./src/hooks/Hooks.js")).default;
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
	const pluginsDir = fileURLToPath(new URL("./src/plugins", import.meta.url));

	// 3. Ensure Directory Structure
	mkdirSync(userPluginsDir, { recursive: true });

	// 4. Register Plugins
	const pluginInstances = await registerPlugins(
		[pluginsDir, userPluginsDir],
		hooks,
	);

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
			entry_size_max: Number(process.env.RUMMY_ENTRY_SIZE_MAX),
		},
	});

	// 6. Initialize plugins (register schemes)
	await initPlugins(db, hooks, pluginInstances);

	// 7. Bootstrap models from env vars
	{
		const modelAliases = [];
		for (const key of Object.keys(process.env)) {
			if (!key.startsWith("RUMMY_MODEL_")) continue;
			const alias = key.replace("RUMMY_MODEL_", "");
			const actual = process.env[key];
			const contextEnv = process.env[`RUMMY_CONTEXT_${alias}`];
			const context_length = contextEnv ? Number.parseInt(contextEnv, 10) : null;
			await db.upsert_model.get({
				alias,
				actual,
				context_length,
			});
			modelAliases.push(alias);
		}
		if (modelAliases.length > 0) {
			console.log(`[RUMMY] Models: ${modelAliases.join(", ")}`);
		}
	}

	// 6b. Database Hygiene — opt-in via RUMMY_RETENTION_DAYS.
	const { statSync } = await import("node:fs");
	const retentionRaw = process.env.RUMMY_RETENTION_DAYS;
	if (retentionRaw == null || retentionRaw === "") {
		const dbSizeMB = (statSync(dbPath).size / 1024 / 1024).toFixed(2);
		console.log(`[RUMMY] DB size: ${dbSizeMB}MB`);
	} else {
		const retentionDays = Number.parseInt(retentionRaw, 10);
		if (!Number.isInteger(retentionDays) || retentionDays < 0) {
			throw new Error(
				`Invalid RUMMY_RETENTION_DAYS=${JSON.stringify(retentionRaw)} ` +
					"(expected non-negative integer)",
			);
		}
		const dbSizeBefore = statSync(dbPath).size;
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
	}

	// 6b. Abort stuck runs (can't be running if the server just started)
	await db.reset_active_loops.run({});
	const aborted = await db.abort_stuck_runs.run({});
	if (aborted.changes > 0) {
		console.log(`[RUMMY] Recovered ${aborted.changes} stuck run(s)`);
	}

	// 6c. Boot complete — DB open, plugins inited, models loaded,
	// hygiene done. Plugins that need a one-shot post-boot action
	// (e.g. the cli plugin firing a programmatic run) subscribe to
	// this event. Fires BEFORE SocketServer so RPC clients can't
	// race a one-shot run still being set up.
	await hooks.boot.completed.emit({ db, hooks });

	// 7. Start RPC Server
	const port = Number.parseInt(process.env.RUMMY_PORT);
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
