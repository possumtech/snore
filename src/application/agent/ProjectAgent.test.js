import assert from "node:assert";
import test from "node:test";
import createHooks from "../../domain/hooks/Hooks.js";
import ProjectAgent from "./ProjectAgent.js";

test("ProjectAgent", async (t) => {
	const mockDb = {
		upsert_project: { run: async () => {} },
		get_project_by_path: { all: async () => [{ id: "p1" }] },
		create_session: { run: async () => {} },
		get_project_by_id: { get: async () => ({ id: "p1", path: "/tmp" }) },
		get_session_by_id: { all: async () => [{ project_id: "p1" }] },
		get_session_skills: { all: async () => [] },
		create_run: { run: async () => {} },
		create_turn: { get: async () => ({ id: 1 }) },
		get_turns_by_run_id: { all: async () => [] },
		update_run_status: { run: async () => {} },
		get_findings_by_run_id: { all: async () => [] },
		get_project_repo_map: { all: async () => [] },
		update_session_system_prompt: { run: async () => {} },
		update_session_persona: { run: async () => {} },
		insert_session_skill: { run: async () => {} },
		delete_session_skill: { run: async () => {} },
		upsert_repo_map_file: { run: async () => {} },
		reset_buffered: { run: async () => {} },
		set_buffered: { run: async () => {} },
		get_turn_history: { all: async () => [] },
		get_unresolved_findings: { all: async () => [] },
		create_empty_turn: { get: async () => ({ id: 1 }) },
		update_turn_stats: { run: async () => {} },
		get_last_turn_sequence: { get: async () => ({ last_seq: null }) },
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
					attributes: '{"sequence":0}',
				},
				{
					id: 2,
					parent_id: 1,
					tag_name: "context",
					content: null,
					attributes: "{}",
				},
				{
					id: 3,
					parent_id: 1,
					tag_name: "assistant",
					content: null,
					attributes: "{}",
				},
				{
					id: 4,
					parent_id: 3,
					tag_name: "meta",
					content: "{}",
					attributes: "{}",
				},
			],
		},
		get_protocol_constraints: {
			get: async () => ({
				required_tags: "tasks",
				allowed_tags: "tasks response",
			}),
		},
		set_retained: { run: async () => {} },
		update_files_visibility_by_pattern: { run: async () => {} },
	};
	const hooks = createHooks();
	const agent = new ProjectAgent(mockDb, hooks);

	await t.test("init should delegate to SessionManager", async () => {
		const result = await agent.init("/tmp", "Project", "c1");
		assert.ok(result.projectId);
		assert.ok(result.sessionId);
	});

	await t.test("ask should delegate to AgentLoop", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								role: "assistant",
								content: "<tasks>- [x] ok</tasks><summary>Hello</summary>",
							},
						},
					],
					usage: { total_tokens: 5 },
				}),
			);

		const result = await agent.ask("s1", "m1", "hi");
		assert.strictEqual(result.status, "completed");
	});

	await t.test("delegating methods should work", async () => {
		assert.ok(Array.isArray(await agent.getFiles("/tmp")));
		assert.ok(await agent.activate("p1", "*"));
		assert.ok(await agent.readOnly("p1", "*"));
		assert.ok(await agent.ignore("p1", "*"));
		assert.ok(await agent.drop("p1", "*"));
		assert.ok(await agent.startRun("s1", { type: "ask" }));
		await agent.setSystemPrompt("s1", "sys");
		await agent.setPersona("s1", "per");
		await agent.addSkill("s1", "sk");
		await agent.removeSkill("s1", "sk");

		const result = await agent.act("s1", "m1", "do it");
		assert.strictEqual(result.status, "completed");
	});
});
