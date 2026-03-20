import assert from "node:assert";
import test from "node:test";
import createHooks from "../../domain/hooks/Hooks.js";
import SocketServer from "./SocketServer.js";

test("SocketServer", async (t) => {
	const mockDb = {};
	const hooks = createHooks();
	const server = new SocketServer(mockDb, { port: 0, hooks });

	await t.test("address should return port", () => {
		const addr = server.address();
		assert.ok(addr.port > 0);
	});

	await t.test("should handle close cleanly", async () => {
		await server.close();
	});

	await t.test("should enable debug mode", async () => {
		process.env.RUMMY_DEBUG = "true";
		const debugServer = new SocketServer(mockDb, { port: 0, hooks });
		assert.ok(debugServer.address().port > 0);
		await debugServer.close();
		delete process.env.RUMMY_DEBUG;
	});
});
