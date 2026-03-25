import assert from "node:assert";
import test from "node:test";
import TestDb from "../../../test/helpers/TestDb.js";
import createHooks from "../../domain/hooks/Hooks.js";
import ClientConnection from "./ClientConnection.js";

test("ClientConnection (Real Integration)", async (t) => {
	let tdb;
	const model = process.env.RUMMY_MODEL_DEFAULT;

	t.before(async () => {
		tdb = await TestDb.create();
	});

	t.after(async () => {
		await tdb.cleanup();
	});

	const createRealConn = () => {
		const state = { sent: [] };
		const ws = {
			on: () => {},
			send: (d) => {
				state.sent.push(JSON.parse(d));
			},
			readyState: 1,
		};
		const conn = new ClientConnection(ws, tdb.db, createHooks());
		return { conn, state };
	};

	const rpc = (conn, method, params = {}, id = 1) =>
		conn.handleMessageForTest(
			Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params, id })),
		);

	const initConn = async () => {
		const { conn, state } = createRealConn();
		await rpc(conn, "init", {
			projectPath: `/tmp/conn-${Date.now()}`,
			projectName: "ConnTest",
			clientId: "c1",
		});
		return { conn, state };
	};

	await t.test("ping should return empty object", async () => {
		const { conn, state } = createRealConn();
		await rpc(conn, "ping");
		assert.deepStrictEqual(state.sent[0].result, {});
	});

	await t.test("discover should return methods and notifications", async () => {
		const { conn, state } = createRealConn();
		await rpc(conn, "discover");
		const result = state.sent[0].result;
		assert.ok(result.methods);
		assert.ok(result.notifications);
		assert.ok(result.methods.ask);
		assert.ok(result.methods.act);
		assert.ok(result.methods.activate);
		assert.ok(result.methods["run/resolve"]);
		assert.ok(result.methods["run/abort"]);
		assert.ok(result.methods["skill/remove"]);
		assert.ok(result.notifications["ui/notify"]);
	});

	await t.test("rpc/discover should also work", async () => {
		const { conn, state } = createRealConn();
		await rpc(conn, "rpc/discover");
		assert.ok(state.sent[0].result.methods);
	});

	await t.test("init should create project and session", async () => {
		const { conn, state } = createRealConn();
		await rpc(conn, "init", {
			projectPath: "/tmp/conn-init",
			projectName: "InitTest",
			clientId: "c1",
		});
		assert.ok(state.sent[0].result.projectId);
		assert.ok(state.sent[0].result.sessionId);
	});

	await t.test("getModels should return model list", async () => {
		const { conn, state } = await initConn();
		await rpc(conn, "getModels", {}, 2);
		const result = state.sent.find((m) => m.id === 2);
		assert.ok(Array.isArray(result.result));
	});

	await t.test("getFiles should return file list after init", async () => {
		const { conn, state } = await initConn();
		await rpc(conn, "getFiles", {}, 2);
		const result = state.sent.find((m) => m.id === 2);
		assert.ok(Array.isArray(result.result));
	});

	await t.test("activate should succeed after init", async () => {
		const { conn, state } = await initConn();
		await rpc(conn, "activate", { pattern: "*.js" }, 2);
		const result = state.sent.find((m) => m.id === 2);
		assert.deepStrictEqual(result.result, { status: "ok" });
	});

	await t.test("readOnly should succeed after init", async () => {
		const { conn, state } = await initConn();
		await rpc(conn, "readOnly", { pattern: "*.js" }, 2);
		const result = state.sent.find((m) => m.id === 2);
		assert.deepStrictEqual(result.result, { status: "ok" });
	});

	await t.test("ignore should succeed after init", async () => {
		const { conn, state } = await initConn();
		await rpc(conn, "ignore", { pattern: "*.log" }, 2);
		const result = state.sent.find((m) => m.id === 2);
		assert.deepStrictEqual(result.result, { status: "ok" });
	});

	await t.test("drop should succeed after init", async () => {
		const { conn, state } = await initConn();
		await rpc(conn, "drop", { pattern: "*" }, 2);
		const result = state.sent.find((m) => m.id === 2);
		assert.deepStrictEqual(result.result, { status: "ok" });
	});

	await t.test("systemPrompt should succeed after init", async () => {
		const { conn, state } = await initConn();
		await rpc(conn, "systemPrompt", { text: "test prompt" }, 2);
		const result = state.sent.find((m) => m.id === 2);
		assert.deepStrictEqual(result.result, { status: "ok" });
	});

	await t.test("persona should succeed after init", async () => {
		const { conn, state } = await initConn();
		await rpc(conn, "persona", { text: "test persona" }, 2);
		const result = state.sent.find((m) => m.id === 2);
		assert.deepStrictEqual(result.result, { status: "ok" });
	});

	await t.test("skill/add and skill/remove should succeed", async () => {
		const { conn, state } = await initConn();
		await rpc(conn, "skill/add", { name: "test-skill" }, 2);
		const addResult = state.sent.find((m) => m.id === 2);
		assert.deepStrictEqual(addResult.result, { status: "ok" });

		await rpc(conn, "skill/remove", { name: "test-skill" }, 3);
		const removeResult = state.sent.find((m) => m.id === 3);
		assert.deepStrictEqual(removeResult.result, { status: "ok" });
	});

	await t.test("methods before init should error", async () => {
		const { conn, state } = createRealConn();
		await rpc(conn, "getFiles");
		assert.ok(state.sent[0].error);
		assert.ok(state.sent[0].error.message.includes("not initialized"));
	});

	await t.test("unknown method should error", async () => {
		const { conn, state } = createRealConn();
		await rpc(conn, "nonExistentMethod");
		assert.ok(state.sent[0].error);
		assert.ok(state.sent[0].error.message.includes("not found"));
	});

	await t.test("run/abort should update run status", async () => {
		const { conn, state } = await initConn();

		// Create a run via startRun
		await rpc(conn, "startRun", { type: "ask" }, 2);
		const startResult = state.sent.find((m) => m.id === 2);
		const runId = startResult.result;

		await rpc(conn, "run/abort", { runId }, 3);
		const abortResult = state.sent.find((m) => m.id === 3);
		assert.deepStrictEqual(abortResult.result, { status: "ok" });
	});

	await t.test("ask should return run status", async () => {
		const { conn, state } = await initConn();

		await rpc(conn, "ask", { model, prompt: "Say 'Ready'." }, 2);

		const start = Date.now();
		let resultMsg = null;
		while (Date.now() - start < 30000) {
			resultMsg = state.sent.find((m) => m.id === 2);
			if (resultMsg) break;
			await new Promise((r) => setTimeout(r, 100));
		}

		assert.ok(resultMsg, "RPC response for 'ask' never arrived");
		assert.ok(
			resultMsg.result,
			`ask returned error: ${resultMsg.error?.message}`,
		);
		assert.ok(resultMsg.result.status);
	});
});
