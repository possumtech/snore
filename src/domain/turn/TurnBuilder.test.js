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
	});

	const mockHooks = {
		processTurn: mock.fn(async () => {}),
	};

	await t.test("build() creates a Turn with expected structure", async () => {
		const getSystemPromptMock = mock.method(
			PromptManager,
			"getSystemPrompt",
			async () => "Base system prompt",
		);
		const builder = new TurnBuilder(mockHooks);
		const turn = await builder.build({
			prompt: "Hello",
			sessionId: "session-1",
			db: createMockDb(),
			type: "ask",
			sequence: 5,
		});

		assert.ok(turn);
		assert.strictEqual(turn.doc.documentElement.getAttribute("sequence"), "5");

		const systemEl = turn.doc.getElementsByTagName("system")[0];
		assert.ok(systemEl.textContent.includes("Base system prompt"));

		const userEl = turn.doc.getElementsByTagName("user")[0];
		assert.ok(userEl.textContent.includes("Hello"));

		const personaEl = turn.doc.getElementsByTagName("persona")[0];
		assert.strictEqual(personaEl.textContent, "Helper");

		const skillEl = turn.doc.getElementsByTagName("skill")[0];
		assert.strictEqual(skillEl.textContent, "git");

		assert.strictEqual(mockHooks.processTurn.mock.calls.length, 1);
		getSystemPromptMock.mock.restore();
	});

	await t.test(
		"build() should fetch protocol_constraints from DB",
		async () => {
			const getSystemPromptMock = mock.method(
				PromptManager,
				"getSystemPrompt",
				async () => "Base system prompt",
			);
			const mockDb = createMockDb();
			mockDb.get_protocol_constraints.get = mock.fn(
				async ({ type, has_unknowns }) => {
					if (has_unknowns) {
						return { required_tags: "req1", allowed_tags: "allow1" };
					}
					return { required_tags: "req2", allowed_tags: "allow2" };
				},
			);

			const builder = new TurnBuilder(mockHooks);

			// Case 1: hasUnknowns = true
			const turn1 = await builder.build({
				prompt: "Hi",
				type: "ask",
				hasUnknowns: true,
				db: mockDb,
			});
			const askEl1 = turn1.doc.getElementsByTagName("ask")[0];
			assert.strictEqual(askEl1.getAttribute("required_tags"), "req1");
			assert.strictEqual(askEl1.getAttribute("allowed_tags"), "allow1");

			// Case 2: hasUnknowns = false
			const turn2 = await builder.build({
				prompt: "Hi",
				type: "ask",
				hasUnknowns: false,
				db: mockDb,
			});
			const askEl2 = turn2.doc.getElementsByTagName("ask")[0];
			assert.strictEqual(askEl2.getAttribute("required_tags"), "req2");
			assert.strictEqual(askEl2.getAttribute("allowed_tags"), "allow2");

			getSystemPromptMock.mock.restore();
		},
	);
});
