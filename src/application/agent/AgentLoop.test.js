import assert from "node:assert";
import test from "node:test";
import createHooks from "../../domain/hooks/Hooks.js";
import AgentLoop from "./AgentLoop.js";

test("AgentLoop", async (t) => {
	const createMockDb = () => ({
		get_session_by_id: { all: async () => [{ project_id: "p1" }] },
		get_project_by_id: { get: async () => ({ id: "p1", path: "/tmp" }) },
		create_run: { run: async () => {} },
		update_run_status: { run: async () => {} },
		get_turns_by_run_id: { all: async () => [] },
		get_findings_by_run_id: { all: async () => [] },
		get_unresolved_findings: { all: async () => [] },
		get_turn_history: { all: async () => [] },
		get_last_turn_sequence: { get: async () => ({ last_seq: null }) },
		create_empty_turn: { get: async () => ({ id: 1 }) },
		update_turn_stats: { run: async () => {} },
		insert_turn_element: { run: async () => {}, get: async () => ({ id: 1 }) },
		reset_buffered: { run: async () => {} },
		set_buffered: { run: async () => {} },
		update_file_attention: { run: async () => {} },
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
			],
		},
		get_protocol_constraints: {
			get: async () => ({
				required_tags: "tasks known unknown",
				allowed_tags: "tasks known unknown read drop env summary",
			}),
		},
	});

	const createMockLlm = () => ({
		completion: async () => ({
			choices: [
				{
					message: {
						role: "assistant",
						content: "<tasks>- [x] done</tasks><summary>Hi</summary>",
					},
				},
			],
			usage: { total_tokens: 10 },
		}),
	});

	const mockTurnBuilder = {
		build: async () => ({
			id: 1,
			toJson: () => ({
				assistant: { content: "Hi", tasks: [], next_task: null, summary: "Hi" },
				errors: [],
				warnings: [],
				infos: [],
			}),
			serialize: async () => [
				{ role: "user", content: "test" },
				{ role: "system", content: "sys" },
			],
			hydrate: async () => {},
			save: async () => {},
		}),
	};

	const mockParser = {
		parseActionTags: (content) => {
			if (content.includes("<create"))
				return [
					{ tagName: "create", attrs: [{ name: "file", value: "b.js" }] },
				];
			if (content.includes("read"))
				return [
					{ tagName: "read", attrs: [{ name: "file", value: "a.js" }] },
					{ tagName: "run", isMock: true, childNodes: [{ value: "ls" }] },
				];
			if (content.includes("summary")) return [{ tagName: "summary" }];
			return [{ tagName: "tasks" }];
		},
		getNodeText: (tag) => {
			if (tag.tagName === "tasks") return "- [x] done";
			return "some text";
		},
		mergePrefill: (p, c) => p + c,
		appendAssistantContent: () => {},
		setAssistantContent: () => {},
	};

	const mockFindings = {
		populateFindings: async () => {},
		resolveOutstandingFindings: async () => ({
			remainingCount: 0,
			proposed: [],
		}),
		applyDiff: async () => {},
	};

	const mockSessionManager = {
		getFiles: async () => [],
	};

	await t.test("run should complete a simple turn", async () => {
		const loop = new AgentLoop(
			createMockDb(),
			createMockLlm(),
			createHooks(),
			mockTurnBuilder,
			mockParser,
			mockFindings,
			mockSessionManager,
		);
		const result = await loop.run("ask", "s1", "m1", "hello");
		assert.strictEqual(result.status, "completed");
	});

	await t.test("run should resume with history", async () => {
		const runId = "r1";
		const mockDb = createMockDb();
		mockDb.get_run_by_id = {
			get: async () => ({ id: runId, session_id: "s1", config: "{}" }),
		};
		mockDb.get_last_turn_sequence = { get: async () => ({ last_seq: 1 }) };
		mockDb.get_turn_history.all = async () => [
			{ id: 1, role: "user" },
			{ id: 2, role: "assistant" },
		];

		const loop = new AgentLoop(
			mockDb,
			createMockLlm(),
			createHooks(),
			mockTurnBuilder,
			mockParser,
			mockFindings,
			mockSessionManager,
		);
		const result = await loop.run("ask", "s1", "m1", "next", null, runId);
		assert.strictEqual(result.status, "completed");
	});

	await t.test("run should block if findings are pending", async () => {
		const runId = "r2";
		const mockDb = createMockDb();
		mockDb.get_run_by_id = {
			get: async () => ({ id: runId, session_id: "s1", config: "{}" }),
		};
		mockDb.get_unresolved_findings.all = async () => [
			{ id: 1, status: "proposed" },
		];

		const loop = new AgentLoop(
			mockDb,
			createMockLlm(),
			createHooks(),
			mockTurnBuilder,
			mockParser,
			mockFindings,
			mockSessionManager,
		);
		const result = await loop.run("ask", "s1", "m1", "next", null, runId);
		assert.strictEqual(result.status, "proposed");
	});

	await t.test("run should terminate on checklist completion", async () => {
		const mockParserWithSummary = {
			...mockParser,
			parseActionTags: (_content) => [
				{
					tagName: "tasks",
					isMock: true,
					childNodes: [{ value: "- [x] all done" }],
				},
				{ tagName: "summary", isMock: true, childNodes: [{ value: "bye" }] },
			],
			getNodeText: (tag) =>
				tag.tagName === "tasks" ? "- [x] all done" : "bye",
		};
		const loop = new AgentLoop(
			createMockDb(),
			createMockLlm(),
			createHooks(),
			mockTurnBuilder,
			mockParserWithSummary,
			mockFindings,
			mockSessionManager,
		);
		const result = await loop.run("ask", "s1", "m1", "finish");
		assert.strictEqual(result.status, "completed");
	});

	await t.test("run should handle yolo mode", async () => {
		const runId = "r_yolo";
		const mockDb = createMockDb();
		mockDb.get_run_by_id = {
			get: async () => ({
				id: runId,
				session_id: "s1",
				config: JSON.stringify({ yolo: true }),
			}),
		};
		mockDb.get_unresolved_findings.all = async () => [
			{
				id: 1,
				status: "proposed",
				category: "command",
				patch: "ls",
				type: "run",
			},
		];
		mockDb.update_finding_command_status = { run: async () => {} };
		mockDb.update_finding_diff_status = { run: async () => {} };

		const loop = new AgentLoop(
			mockDb,
			createMockLlm(),
			createHooks(),
			mockTurnBuilder,
			mockParser,
			mockFindings,
			mockSessionManager,
		);
		const result = await loop.run("ask", "s1", "m1", "yolo", null, runId);
		assert.strictEqual(result.status, "completed");
	});

	await t.test("run should handle information gathering", async () => {
		let callCount = 0;
		const mockLlmLocal = {
			completion: async () => {
				callCount++;
				if (callCount === 1)
					return {
						choices: [
							{
								message: {
									role: "assistant",
									content: '<read file="a.js"/><run>ls</run>',
								},
							},
						],
						usage: { total_tokens: 10 },
					};
				return {
					choices: [
						{
							message: {
								role: "assistant",
								content: "<tasks>- [x] done</tasks><summary>Done</summary>",
							},
						},
					],
					usage: { total_tokens: 5 },
				};
			},
		};

		const loop = new AgentLoop(
			createMockDb(),
			mockLlmLocal,
			createHooks(),
			mockTurnBuilder,
			mockParser,
			mockFindings,
			mockSessionManager,
		);
		const result = await loop.run("ask", "s1", "m1", "gather");
		assert.strictEqual(result.status, "completed");
	});

	await t.test("run should stop on breaking changes", async () => {
		const mockLlmBreaking = {
			completion: async () => ({
				choices: [
					{
						message: {
							role: "assistant",
							content: '<create file="b.js">content</create>',
						},
					},
				],
				usage: { total_tokens: 10 },
			}),
		};
		const mockDb = createMockDb();
		mockDb.insert_finding_diff = { run: async () => {} };
		mockDb.insert_finding_command = { run: async () => {} };
		mockDb.insert_finding_notification = { run: async () => {} };

		const loop = new AgentLoop(
			mockDb,
			mockLlmBreaking,
			createHooks(),
			mockTurnBuilder,
			mockParser,
			mockFindings,
			mockSessionManager,
		);
		const result = await loop.run("ask", "s1", "m1", "breaking");
		assert.strictEqual(result.status, "proposed");
	});
});
