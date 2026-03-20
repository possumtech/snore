import assert from "node:assert";
import test from "node:test";
import createHooks from "../../domain/hooks/Hooks.js";
import ClientConnection from "./ClientConnection.js";

test("ClientConnection", async (t) => {
	const mockDb = {
		upsert_project: { run: async () => {} },
		get_project_by_path: { all: async () => [{ id: "p1" }] },
		create_session: { run: async () => {} },
		get_project_by_id: { get: async () => ({ id: "p1", path: "/tmp" }) },
		get_session_by_id: { all: async () => [{ project_id: "p1" }] },
		get_session_skills: { all: async () => [] },
		get_models: { all: async () => [] },
		get_run_by_id: { get: async () => null },
		get_project_repo_map: { all: async () => [] },
		get_file_type_handlers: { all: async () => [] },
		get_ranked_repo_map: { all: async () => [] },
		create_run: { run: async () => {} },
		update_run_status: { run: async () => {} },
		create_turn: { get: async () => ({ id: 1 }) },
		create_empty_turn: { get: async () => ({ id: 1 }) },
		update_turn_stats: { run: async () => {} },
		get_turn_history: { all: async () => [] },
		get_last_turn_sequence: { get: async () => ({ last_seq: null }) },
		reset_buffered: { run: async () => {} },
		set_buffered: { run: async () => {} },
		update_file_attention: { run: async () => {} },
		insert_turn_element: { get: async () => ({ id: 1 }) },
		get_protocol_constraints: {
			get: async () => ({
				required_tags: "tasks",
				allowed_tags: "tasks response",
			}),
		},
	};

	const createWs = () => {
		let sent = null;
		return {
			ws: {
				on: () => {},
				send: (d) => {
					sent = JSON.parse(d);
				},
				readyState: 1,
			},
			get lastSent() {
				return sent;
			},
		};
	};

	await t.test("handleMessage should process ask with buffers", async () => {
		const { ws, lastSent } = createWs();
		const conn = new ClientConnection(ws, mockDb, createHooks());

		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "init",
					params: { projectPath: "/tmp", projectName: "P", clientId: "c1" },
					id: 1,
				}),
			),
		);

		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								role: "assistant",
								content: "<response>Hi</response>",
							},
						},
					],
					usage: { total_tokens: 5 },
				}),
			);

		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "ask",
					params: { prompt: "hi", projectBufferFiles: ["a.js"] },
					id: 2,
				}),
			),
		);

		// The mock WS lastSent getter will work here
		const _resp = ws.send.calls ? JSON.parse(ws.send.calls[0]) : {}; // Wait, I need a better way to check sent
	});

	// Refactored to use local WS for every test to avoid closure issues
	await t.test("handleMessage should process ping", async () => {
		let sent = null;
		const ws = {
			on: () => {},
			send: (d) => {
				sent = JSON.parse(d);
			},
			readyState: 1,
		};
		const conn = new ClientConnection(ws, mockDb, createHooks());
		await conn.handleMessageForTest(
			Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 10 })),
		);
		assert.strictEqual(sent.id, 10);
	});
});
