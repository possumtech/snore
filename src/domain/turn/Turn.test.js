import assert from "node:assert";
import test from "node:test";
import Turn from "./Turn.js";

test("Turn class", async (t) => {
	const mockElements = [
		{
			id: 1,
			parent_id: null,
			tag_name: "turn",
			content: null,
			attributes: '{"sequence":1}',
			sequence: 0,
		},
		{
			id: 2,
			parent_id: 1,
			tag_name: "system",
			content: "System prompt",
			attributes: "{}",
			sequence: 0,
		},
		{
			id: 3,
			parent_id: 1,
			tag_name: "context",
			content: null,
			attributes: "{}",
			sequence: 1,
		},
		{
			id: 4,
			parent_id: 3,
			tag_name: "file",
			content: null,
			attributes: '{"path":"a.js"}',
			sequence: 0,
		},
		{
			id: 5,
			parent_id: 4,
			tag_name: "source",
			content: "code",
			attributes: "{}",
			sequence: 0,
		},
		{
			id: 6,
			parent_id: 1,
			tag_name: "user",
			content: "user prompt",
			attributes: "{}",
			sequence: 2,
		},
		{
			id: 7,
			parent_id: 1,
			tag_name: "assistant",
			content: null,
			attributes: "{}",
			sequence: 3,
		},
		{
			id: 8,
			parent_id: 7,
			tag_name: "content",
			content: "assistant content",
			attributes: "{}",
			sequence: 0,
		},
		{
			id: 9,
			parent_id: 7,
			tag_name: "tasks",
			content: "- [x] Done",
			attributes: "{}",
			sequence: 1,
		},
		{
			id: 10,
			parent_id: 7,
			tag_name: "meta",
			content: '{"total_tokens":30}',
			attributes: "{}",
			sequence: 2,
		},
	];

	const mockDb = {
		get_turn_elements: {
			all: async () => mockElements,
		},
	};

	await t.test("constructor and id getter", () => {
		const turn = new Turn(mockDb, 123);
		assert.strictEqual(turn.id, 123);
	});

	await t.test("hydrate() and toJson()", async () => {
		const turn = new Turn(mockDb, 123);
		await turn.hydrate();
		const json = turn.toJson();

		assert.strictEqual(json.sequence, 1);
		assert.strictEqual(json.system, "System prompt");
		assert.strictEqual(json.user, "user prompt");
		assert.strictEqual(json.assistant.content, "assistant content");
		assert.strictEqual(json.assistant.tasks.length, 1);
		assert.strictEqual(json.assistant.tasks[0].completed, true);
		assert.strictEqual(json.usage.total_tokens, 30);
	});

	await t.test("serialize()", async () => {
		const turn = new Turn(mockDb, 123);
		const msgs = await turn.serialize();

		assert.strictEqual(msgs.length, 3);
		assert.strictEqual(msgs[0].role, "system");
		assert.strictEqual(msgs[1].role, "user");
		assert.ok(msgs[1].content.includes("<context"));
		assert.strictEqual(msgs[2].role, "assistant");
	});

	await t.test("toXml()", async () => {
		const turn = new Turn(mockDb, 123);
		await turn.hydrate();
		const xml = turn.toXml();
		assert.ok(xml.includes("<turn"));
		assert.ok(xml.includes("<system>System prompt</system>"));
	});
});
