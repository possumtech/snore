import assert from "node:assert";
import fs from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import SqlRite from "@possumtech/sqlrite";
import { WebSocket } from "ws";
import SocketServer from "../../src/socket/SocketServer.js";

describe("E2E Flow: getModels", () => {
	let db;
	let server;
	const port = process.env.PORT;
	const dbPath = `test_e2e_${port}.db`;

	before(async () => {
		await fs.unlink(dbPath).catch(() => {});
		db = await SqlRite.open({
			path: dbPath,
			dir: ["migrations", "src"],
		});

		server = new SocketServer(db, { port });
	});

	after(async () => {
		if (server) await server.close();
		if (db) await db.close();
		await fs.unlink(dbPath).catch(() => {});
	});

	it("should respond to getModels request with a list of models over WebSocket", {
		timeout: 10000,
	}, async () => {
		const ws = new WebSocket(`ws://localhost:${port}`);

		const response = await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error("Timeout"));
			}, 8000);

			ws.on("open", () => {
				ws.send(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "getModels",
						id: 1,
					}),
				);
			});

			ws.on("message", (data) => {
				clearTimeout(timeout);
				resolve(JSON.parse(data.toString()));
				ws.close();
			});

			ws.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		assert.strictEqual(response.id, 1);
		assert.ok(Array.isArray(response.result));
		assert.ok(response.result.some((m) => m.id === "gpt-4o"));
	});
});
