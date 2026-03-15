import SqlRite from "@possumtech/sqlrite";
import SocketServer from "./src/socket/SocketServer.js";
import { registerCorePlugins } from "./src/plugins/index.js";

async function main() {
	const dbPath = process.env.SNORE_DB_PATH || "snore.db";
	const db = await SqlRite.open({
		path: dbPath,
		dir: ["migrations", "src"],
	});

	// Register internal hooks & filters
	registerCorePlugins();

	const port = Number.parseInt(process.env.PORT);
	const server = new SocketServer(db, { port });

	server.on("error", (err) => {
		if (err.code === "EADDRINUSE") {
			console.error(`SNORE Critical: Port ${port} is already in use.`);
			process.exit(1);
		}
		throw err;
	});

	console.log(`SNORE Service Operational [Port ${port}]`);
}

main().catch((err) => {
	console.error("SNORE Failed to boot:", err.message);
	process.exit(1);
});
