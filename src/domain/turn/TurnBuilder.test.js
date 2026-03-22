import assert from "node:assert";
import test, { mock } from "node:test";
import PromptManager from "../prompt/PromptManager.js";
import TurnBuilder from "./TurnBuilder.js";

test("TurnBuilder class", async (t) => {
	const createMockDb = () => ({
		get_session_by_id: {
			all: mock.fn(async () => [
				{ system_prompt: "Custom prompt", persona: "Helper" },
			]),
		},
		get_session_skills: {
			all: mock.fn(async () => [{ name: "git" }]),
		},
		get_protocol_constraints: {
			get: mock.fn(async () => ({
				required_tags: "tasks known unknown",
				allowed_tags: "tasks known unknown read env",
			})),
		},
		get_turn_elements: {
			all: mock.fn(async () => [
				{
					id: 1,
					parent_id: null,
					tag_name: "turn",
					content: null,
					attributes: '{"sequence":5}',
					sequence: 0,
				},
				{
					id: 2,
					parent_id: 1,
					tag_name: "assistant",
					content: null,
					attributes: "{}",
					sequence: 3,
				},
				{
					id: 3,
					parent_id: 2,
					tag_name: "meta",
					content: "{}",
					attributes: "{}",
					sequence: 0,
				},
			]),
		},
		insert_turn_element: {
			get: mock.fn(async (params) => ({ id: 1, sequence: params.sequence })),
			run: mock.fn(async () => {}),
		},
		update_turn_payload: {
			run: mock.fn(async () => {}),
		},
	});

	const mockHooks = {
		processTurn: mock.fn(async () => {}),
	};

	await t.test("build() creates a Turn and commits to DB", async (_t) => {
		const getSystemPromptMock = mock.method(
			PromptManager,
			"getSystemPrompt",
			async () => "Base system prompt",
		);
		const builder = new TurnBuilder(mockHooks);
		const db = createMockDb();
		const turn = await builder.build({
			prompt: "Hello",
			sessionId: "session-1",
			db,
			type: "ask",
			turnId: 123,
			sequence: 5,
		});

		assert.ok(turn);
		assert.strictEqual(turn.id, 123);

		// Verify DB was called (traverse will call insert for turn, system, context, user, assistant)
		assert.ok(db.insert_turn_element.get.mock.calls.length > 0);
		assert.ok(db.update_turn_payload.run.mock.calls.length > 0);

		assert.strictEqual(mockHooks.processTurn.mock.calls.length, 1);
		getSystemPromptMock.mock.restore();
	});
});
