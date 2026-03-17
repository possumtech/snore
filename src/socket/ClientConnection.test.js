import assert from "node:assert";
import { after, before, describe, it, mock } from "node:test";
import createHooks from "../core/Hooks.js";
import { registerPlugins } from "../plugins/index.js";
import ClientConnection from "./ClientConnection.js";
import TestDb from "../../test/helpers/TestDb.js";

describe("ClientConnection", () => {
	let hooks;
	let tdb;

	before(async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
		process.env.RUMMY_MODEL_DEFAULT = "test-model";
		process.env.RUMMY_HTTP_REFERER = "http://test";
		process.env.RUMMY_X_TITLE = "Test";
		hooks = createHooks();
		await registerPlugins([], hooks);
		tdb = await TestDb.create("client_connection");
	});

	after(async () => {
		if (tdb) await tdb.cleanup();
	});

	const createMocks = () => {
		const ws = { on: mock.fn(), send: mock.fn(), readyState: 1 };
		return { ws, db: tdb.db };
	};

	const runMethod = async (conn, ws, method, params = {}, id = "req") => {
		const message = JSON.stringify({ jsonrpc: "2.0", method, params, id });
		await conn.handleMessageForTest(message);
		const lastCall = ws.send.mock.calls[ws.send.mock.calls.length - 1];
		return JSON.parse(lastCall.arguments[0]);
	};

	it("should handle 'init' method", async () => {
		const { ws, db } = createMocks();
		const conn = new ClientConnection(ws, db, hooks);
		const response = await runMethod(conn, ws, "init", {
			projectPath: process.cwd(),
			projectName: "Test Project",
			clientId: "test-client"
		});
		assert.ok(response.result.projectId);
		assert.ok(response.result.sessionId);
	});

	it("should handle 'ask' method", async () => {
		const { ws, db } = createMocks();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(
			JSON.stringify({
				model: "test-model",
				choices: [{ message: { role: "assistant", content: "Paris" } }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		);

		try {
			const conn = new ClientConnection(ws, db, hooks);
			await runMethod(conn, ws, "init", { projectPath: process.cwd(), projectName: "T", clientId: "c" });
			const response = await runMethod(conn, ws, "ask", {
				model: "test-model",
				prompt: "p",
			});
			assert.strictEqual(response.result.content, "Paris");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
