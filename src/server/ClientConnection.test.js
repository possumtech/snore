import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import createHooks from "../hooks/Hooks.js";
import ClientConnection from "./ClientConnection.js";

class MockWs extends EventEmitter {
	constructor() {
		super();
		this.readyState = 1;
		this.sent = [];
		this.terminated = false;
	}
	send(payload) {
		this.sent.push(JSON.parse(payload));
	}
	terminate() {
		this.terminated = true;
	}
}

function makeDb({ runRow = null } = {}) {
	const calls = [];
	return {
		_calls: calls,
		get_all_schemes: { all: async () => [] },
		log_rpc_call: { get: async () => null },
		log_rpc_result: { run: async () => null },
		log_rpc_error: { run: async () => null },
		get_run_by_id: { get: async () => runRow },
	};
}

function makeMockRegistry(methods = {}) {
	return {
		get: (name) => methods[name],
		discover: () => ({ methods: {}, notifications: {} }),
		has: (name) => name in methods,
	};
}

describe("ClientConnection", () => {
	let originalTimeout;
	let originalRpcLog;

	beforeEach(() => {
		originalTimeout = process.env.RUMMY_RPC_TIMEOUT;
		originalRpcLog = console.error;
		// Suppress error log noise from negative-path tests.
		console.error = () => {};
		process.env.RUMMY_RPC_TIMEOUT = "5000";
	});

	afterEach(() => {
		console.error = originalRpcLog;
		if (originalTimeout === undefined) delete process.env.RUMMY_RPC_TIMEOUT;
		else process.env.RUMMY_RPC_TIMEOUT = originalTimeout;
	});

	it("constructor wires socket, hooks, and ProjectAgent without crashing", () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeMockRegistry();
		const conn = new ClientConnection(new MockWs(), makeDb(), hooks);
		assert.ok(conn);
	});

	it("dispatches a registered method with returned result over the socket", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeMockRegistry({
			ping: { handler: async () => ({ status: "ok" }) },
		});
		const ws = new MockWs();
		const conn = new ClientConnection(ws, makeDb(), hooks);
		await conn.handleMessageForTest(
			Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 })),
		);
		assert.equal(ws.sent.length, 1);
		assert.deepEqual(ws.sent[0], {
			jsonrpc: "2.0",
			result: { status: "ok" },
			id: 1,
		});
	});

	it("rejects unknown method with JSON-RPC error", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeMockRegistry();
		const ws = new MockWs();
		const conn = new ClientConnection(ws, makeDb(), hooks);
		await conn.handleMessageForTest(
			Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "no_such", id: 2 })),
		);
		assert.equal(ws.sent.length, 1);
		assert.ok(ws.sent[0].error);
		assert.equal(ws.sent[0].id, 2);
	});

	it("rejects requiresInit method when projectId not set", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeMockRegistry({
			restricted: {
				requiresInit: true,
				handler: async () => ({ ok: true }),
			},
		});
		const ws = new MockWs();
		const conn = new ClientConnection(ws, makeDb(), hooks);
		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({ jsonrpc: "2.0", method: "restricted", id: 3 }),
			),
		);
		assert.ok(ws.sent[0].error);
	});

	it("treats rpc/discover as alias for discover", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeMockRegistry({
			discover: { handler: async () => ({ methods: {}, notifications: {} }) },
		});
		const ws = new MockWs();
		const conn = new ClientConnection(ws, makeDb(), hooks);
		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({ jsonrpc: "2.0", method: "rpc/discover", id: 4 }),
			),
		);
		assert.deepEqual(ws.sent[0].result, { methods: {}, notifications: {} });
	});

	it("malformed JSON returns error with id=null", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeMockRegistry();
		const ws = new MockWs();
		const conn = new ClientConnection(ws, makeDb(), hooks);
		await conn.handleMessageForTest(Buffer.from("{not-json"));
		assert.ok(ws.sent[0].error);
		assert.equal(ws.sent[0].id, null);
	});

	it("missing params defaults to empty object passed to handler", async () => {
		const hooks = createHooks();
		let captured;
		hooks.rpc.registry = makeMockRegistry({
			peek: {
				handler: async (params) => {
					captured = params;
					return {};
				},
			},
		});
		const ws = new MockWs();
		const conn = new ClientConnection(ws, makeDb(), hooks);
		await conn.handleMessageForTest(
			Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "peek", id: 5 })),
		);
		assert.deepEqual(captured, {});
	});

	it("longRunning handlers skip the RPC timeout race", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeMockRegistry({
			slowboat: {
				longRunning: true,
				handler: async () => {
					// Simulate slow but bounded handler — would time out a non-long handler.
					await new Promise((r) => setTimeout(r, 20));
					return { ok: true };
				},
			},
		});
		// Timeout below the handler delay; only matters if longRunning gates it off.
		process.env.RUMMY_RPC_TIMEOUT = "5";
		const ws = new MockWs();
		const conn = new ClientConnection(ws, makeDb(), hooks);
		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({ jsonrpc: "2.0", method: "slowboat", id: 6 }),
			),
		);
		assert.deepEqual(ws.sent[0].result, { ok: true });
	});

	it("non-longRunning handlers timeout when slow", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeMockRegistry({
			hang: {
				handler: () => new Promise(() => {}),
			},
		});
		process.env.RUMMY_RPC_TIMEOUT = "10";
		const ws = new MockWs();
		const conn = new ClientConnection(ws, makeDb(), hooks);
		await conn.handleMessageForTest(
			Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "hang", id: 7 })),
		);
		assert.ok(ws.sent[0].error);
		assert.match(ws.sent[0].error.message, /timed?\s?out|timeout/i);
	});

	it("ws.close triggers shutdown — second shutdown is idempotent", async () => {
		const hooks = createHooks();
		hooks.rpc.registry = makeMockRegistry();
		const ws = new MockWs();
		const conn = new ClientConnection(ws, makeDb(), hooks);
		// Trigger shutdown twice; second call must reuse the cached promise.
		const a = conn.shutdown();
		const b = conn.shutdown();
		assert.strictEqual(a, b);
		await a;
		assert.equal(ws.terminated, true);
	});
});
