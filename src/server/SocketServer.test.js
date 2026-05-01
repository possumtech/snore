import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import createHooks from "../hooks/Hooks.js";
import SocketServer from "./SocketServer.js";

function makeDb() {
	return {
		get_all_schemes: { all: async () => [] },
		log_rpc_call: { get: async () => null },
		log_rpc_result: { run: async () => null },
		log_rpc_error: { run: async () => null },
		get_run_by_id: { get: async () => null },
	};
}

function makeRpcRegistry() {
	const methods = new Map();
	return {
		register(name, def) {
			methods.set(name, def);
		},
		get: (name) => methods.get(name),
		discover: () => ({ methods: {}, notifications: {} }),
		has: (name) => methods.has(name),
	};
}

describe("SocketServer", () => {
	it("opens on an ephemeral port and accepts a WebSocket connection", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeRpcRegistry();
		hooks.rpc.registry.register("ping", {
			handler: async () => ({ ok: true }),
		});

		const server = new SocketServer(makeDb(), { port: 0, hooks });
		const { port } = server.address();
		assert.equal(typeof port, "number");
		assert.ok(port > 0);

		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await new Promise((resolve, reject) => {
			ws.on("open", resolve);
			ws.on("error", reject);
		});

		const reply = await new Promise((resolve, reject) => {
			ws.on("message", (data) => resolve(JSON.parse(data.toString())));
			ws.on("error", reject);
			ws.send(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }));
		});
		assert.equal(reply.id, 1);
		assert.deepEqual(reply.result, { ok: true });

		ws.close();
		await server.close();
	});

	it("close() drains active connections and stops the server", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeRpcRegistry();
		const server = new SocketServer(makeDb(), { port: 0, hooks });
		const { port } = server.address();
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await new Promise((resolve, reject) => {
			ws.on("open", resolve);
			ws.on("error", reject);
		});
		await server.close();
		// After close, attempt to dial fails (server gone).
		await new Promise((resolve) => {
			const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
			ws2.on("error", resolve);
		});
	});

	it("on(event, handler) forwards to the underlying WebSocketServer", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeRpcRegistry();
		const server = new SocketServer(makeDb(), { port: 0, hooks });
		let connectionEvts = 0;
		server.on("connection", () => connectionEvts++);
		const { port } = server.address();
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		await new Promise((resolve, reject) => {
			ws.on("open", resolve);
			ws.on("error", reject);
		});
		assert.ok(connectionEvts >= 1);
		ws.close();
		await server.close();
	});
});
