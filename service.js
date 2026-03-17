import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import SqlRite from "@possumtech/sqlrite";
import SocketServer from "./src/socket/SocketServer.js";
import { registerPlugins } from "./src/plugins/index.js";
import createHooks from "./src/core/Hooks.js";

async function main() {
	// 1. Initialize Hooks (Agnostic Engine)
	const debug = process.env.RUMMY_DEBUG === "true";
	const hooks = createHooks(debug);

	// 2. Resolve RUMMY_HOME (Default: ~/.rummy)
	const rummyHome = process.env.RUMMY_HOME || join(homedir(), ".rummy");
	const userPluginsDir = join(rummyHome, "plugins");
	const internalPluginsDir = fileURLToPath(new URL("./src/internal", import.meta.url));
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

	// 6. Start RPC Server
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
