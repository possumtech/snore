import assert from "node:assert";
import { before, describe, it, mock } from "node:test";
import ClientConnection from "./ClientConnection.js";

describe("ClientConnection", () => {
	before(() => {
		process.env.OPENROUTER_API_KEY = "test-key";
		process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
		process.env.SNORE_DEFAULT_MODEL = "test-model";
		process.env.SNORE_HTTP_REFERER = "http://test";
		process.env.SNORE_X_TITLE = "Test";
	});

	const createMocks = () => {
		const ws = { on: mock.fn(), send: mock.fn(), readyState: 1 };
		const db = {
			upsert_project: { run: mock.fn() },
			get_project_by_path: { all: mock.fn(async () => [{ id: "p1" }]) },
			get_project_by_id: {
				get: mock.fn(async () => ({ id: "p1", path: process.cwd() })),
			},
			get_session_by_id: { all: mock.fn(async () => [{ project_id: "p1" }]) },
			create_session: { run: mock.fn() },
			get_repo_map_file: { get: mock.fn(async () => null) },
			upsert_repo_map_file: {
				run: mock.fn(),
				get: mock.fn(async () => ({ id: "f1" })),
			},
			clear_repo_map_file_data: { run: mock.fn() },
			insert_repo_map_tag: { run: mock.fn() },
			insert_repo_map_ref: { run: mock.fn() },
			get_project_repo_map: { all: mock.fn(async () => []) },
			get_models: { all: mock.fn(async () => []) },
			get_file_references: { all: mock.fn(async () => []) },
			create_job: { run: mock.fn() },
			create_turn: { run: mock.fn() },
			update_job_status: { run: mock.fn() },
		};
		return { ws, db };
	};

	const runMethod = async (conn, ws, method, params = {}, id = "req") => {
		const message = JSON.stringify({ jsonrpc: "2.0", method, params, id });
		await conn.handleMessageForTest(message);
		return JSON.parse(
			ws.send.mock.calls[ws.send.mock.calls.length - 1].arguments[0],
		);
	};

	it("should handle 'init' method", async () => {
		const { ws, db } = createMocks();
		const conn = new ClientConnection(ws, db);
		const response = await runMethod(conn, ws, "init", {
			projectPath: process.cwd(),
		});
		assert.strictEqual(response.result.projectId, "p1");
	});

	it("should handle 'ask' method", async () => {
		const { ws, db } = createMocks();
		mock.method(globalThis, "fetch", async () => ({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: "Paris" } }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
		}));
		const conn = new ClientConnection(ws, db);
		await runMethod(conn, ws, "init", { projectPath: process.cwd() });
		const response = await runMethod(conn, ws, "ask", {
			model: process.env.SNORE_DEFAULT_MODEL,
			prompt: "Capital?",
		});
		assert.strictEqual(response.result.response, "Paris");
	});
});
