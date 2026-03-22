import assert from "node:assert";
import test from "node:test";
import createHooks from "../../domain/hooks/Hooks.js";
import ClientConnection from "./ClientConnection.js";

test("ClientConnection Expanded Coverage", async (t) => {
	// Setup necessary env for LLM clients
	process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
	process.env.OLLAMA_BASE_URL = "http://localhost:11434";
	process.env.RUMMY_MODEL_DEFAULT = "ccp";

	const mockDb = {
		upsert_project: { run: async () => {} },
		get_project_by_path: { all: async () => [{ id: "p1" }] },
		create_session: { run: async () => {} },
		get_project_by_id: { get: async () => ({ id: "p1", path: "/tmp" }) },
		get_session_by_id: { all: async () => [{ project_id: "p1" }] },
		get_session_skills: { all: async () => [] },
		get_models: { all: async () => [] },
		get_run_by_id: {
			get: async () => ({ id: "r1", session_id: "s1", config: "{}" }),
		},
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
		insert_turn_element: { run: async () => {}, get: async () => ({ id: 1 }) },
		update_turn_payload: { run: async () => {} },
		get_turn_elements: {
			all: async () => [
				{
					id: 1,
					parent_id: null,
					tag_name: "turn",
					content: null,
					attributes: "{}",
				},
				{
					id: 2,
					parent_id: 1,
					tag_name: "assistant",
					content: null,
					attributes: "{}",
				},
				{
					id: 3,
					parent_id: 2,
					tag_name: "meta",
					content: "{}",
					attributes: "{}",
				},
			],
		},
		get_protocol_constraints: {
			get: async () => ({
				required_tags: "tasks",
				allowed_tags: "tasks summary",
			}),
		},
		get_repo_map_file: {
			get: async () => ({ is_buffered: 0, size: 0, visibility: "mappable" }),
		},
		insert_session_skill: { run: async () => {} },
		delete_session_skill: { run: async () => {} },
		update_session_system_prompt: { run: async () => {} },
		update_session_persona: { run: async () => {} },
		upsert_repo_map_file: { run: async () => {} },
		insert_finding_notification: { run: async () => {} },
		get_findings_by_run_id: { all: async () => [] },
		get_unresolved_findings: { all: async () => [] },
		update_files_visibility_by_pattern: { run: async () => {} },
	};

	const createMockConn = () => {
		const state = { sent: null };
		const ws = {
			on: () => {},
			send: (d) => {
				state.sent = JSON.parse(d);
			},
			readyState: 1,
		};
		const conn = new ClientConnection(ws, mockDb, createHooks());
		return { conn, state };
	};

	await t.test(
		"should handle basic lifecycle: ping, discover, init",
		async () => {
			const { conn, state } = createMockConn();

			await conn.handleMessageForTest(
				Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 })),
			);
			assert.deepStrictEqual(state.sent.result, {});

			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({ jsonrpc: "2.0", method: "discover", id: 2 }),
				),
			);
			assert.ok(state.sent.result.methods.init);

			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "init",
						id: 3,
						params: { projectPath: "/tmp", projectName: "P", clientId: "c1" },
					}),
				),
			);
			assert.strictEqual(state.sent.result.projectId, "p1");
		},
	);

	await t.test("should handle model and file metadata", async () => {
		const { conn, state } = createMockConn();
		// Init first
		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "init",
					id: 1,
					params: { projectPath: "/tmp" },
				}),
			),
		);

		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({ jsonrpc: "2.0", method: "getModels", id: 2 }),
			),
		);
		assert.ok(Array.isArray(state.sent.result));

		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({ jsonrpc: "2.0", method: "getFiles", id: 3 }),
			),
		);
		assert.ok(Array.isArray(state.sent.result));

		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "fileStatus",
					id: 4,
					params: { path: "a.js" },
				}),
			),
		);
		assert.strictEqual(state.sent.result.path, "a.js");

		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "activate",
					id: 5,
					params: { pattern: "a.js" },
				}),
			),
		);
		assert.strictEqual(state.sent.result.status, "ok");
	});

	await t.test(
		"should handle run lifecycle: start, resolve, affirm, abort",
		async () => {
			const { conn, state } = createMockConn();
			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "init",
						id: 1,
						params: { projectPath: "/tmp" },
					}),
				),
			);

			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "startRun",
						id: 2,
						params: { type: "ask" },
					}),
				),
			);
			assert.ok(state.sent.result);

			// Mock global fetch for LLM call inside resolve
			globalThis.fetch = async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									role: "assistant",
									content: "<tasks>- [x] ok</tasks><summary>Done</summary>",
								},
							},
						],
						usage: { total_tokens: 10 },
					}),
				);

			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "run/resolve",
						id: 3,
						params: { runId: "r1", resolution: { action: "accepted" } },
					}),
				),
			);
			// Success check
			assert.ok(!state.sent.error);

			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "run/affirm",
						id: 4,
						params: { runId: "r1" },
					}),
				),
			);
			assert.strictEqual(state.sent.result.status, "ok");

			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "run/abort",
						id: 5,
						params: { runId: "r1" },
					}),
				),
			);
			assert.strictEqual(state.sent.result.status, "ok");
		},
	);

	await t.test(
		"should handle session configuration: prompt, persona, skills",
		async () => {
			const { conn, state } = createMockConn();
			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "init",
						id: 1,
						params: { projectPath: "/tmp" },
					}),
				),
			);

			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "systemPrompt",
						id: 2,
						params: { text: "new prompt" },
					}),
				),
			);
			assert.strictEqual(state.sent.result.status, "ok");

			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "persona",
						id: 3,
						params: { text: "new persona" },
					}),
				),
			);
			assert.strictEqual(state.sent.result.status, "ok");

			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "skill/add",
						id: 4,
						params: { name: "s1" },
					}),
				),
			);
			assert.strictEqual(state.sent.result.status, "ok");

			await conn.handleMessageForTest(
				Buffer.from(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "skill/remove",
						id: 5,
						params: { name: "s1" },
					}),
				),
			);
			assert.strictEqual(state.sent.result.status, "ok");
		},
	);

	await t.test("should handle ask/act/run with buffer sync", async () => {
		const { conn, state } = createMockConn();
		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "init",
					id: 1,
					params: { projectPath: "/tmp" },
				}),
			),
		);

		// Mock global fetch for LLM call
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								role: "assistant",
								content: "<tasks>- [x] ok</tasks><summary>Done</summary>",
							},
						},
					],
					usage: { total_tokens: 10 },
				}),
			);

		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "ask",
					id: 2,
					params: { prompt: "hi", projectBufferFiles: ["a.js"] },
				}),
			),
		);
		assert.strictEqual(state.sent.id, 2);

		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "act",
					id: 3,
					params: { prompt: "do it" },
				}),
			),
		);
		assert.strictEqual(state.sent.id, 3);

		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "run",
					id: 4,
					params: { prompt: "go" },
				}),
			),
		);
		assert.strictEqual(state.sent.id, 4);
	});

	await t.test("should throw error if project not initialized", async () => {
		const { conn, state } = createMockConn();
		await conn.handleMessageForTest(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "getFiles",
					id: 1,
				}),
			),
		);
		assert.ok(state.sent.error);
		assert.match(state.sent.error.message, /not initialized/);
	});
});
