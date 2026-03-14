import SqlRite from "@possumtech/sqlrite";
import SocketServer from "./src/socket/SocketServer.js";

async function main() {
	// sqlrite uses 'path' for the db file and 'dir' for the sql files/migrations
	const db = await SqlRite.open({
		path: "snore.db",
		dir: ["migrations", "src"],
	});

	new SocketServer(db, { port: process.env.PORT });

	console.log(`SNORE service started on ws://localhost:${process.env.PORT}`);
}

main().catch((err) => {
	console.error("Failed to start SNORE service:", err);
	process.exit(1);
});
