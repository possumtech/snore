import assert from "node:assert";
import { randomUUID } from "node:crypto";
import test from "node:test";
import TestDb from "../../../test/helpers/TestDb.js";
import Turn from "./Turn.js";

test("Turn", async (t) => {
	let tdb, db, turnId;

	t.before(async () => {
		tdb = await TestDb.create();
		db = tdb.db;

		// Create prerequisite project -> session -> run
		const projectId = randomUUID();
		const sessionId = randomUUID();
		const runId = randomUUID();

		await db.upsert_project.get({
			id: projectId,
			path: "/tmp/turn-test",
			name: "TurnTest",
		});
		await db.create_session.get({
			id: sessionId,
			project_id: projectId,
			client_id: "c1",
		});
		await db.create_run.get({
			id: runId,
			session_id: sessionId,
			parent_run_id: null,
			type: "ask",
			config: "{}",
		});

		// Create the turn
		const turn = await db.create_empty_turn.get({ run_id: runId, sequence: 1 });
		turnId = turn.id;

		// Insert the turn element tree:
		// <turn sequence="1">
		//   <system>You are a helpful assistant.</system>
		//   <context><files><file path="src/a.js" size="42" tokens="10"><source>const a = 1;</source></file></files></context>
		//   <user>Fix the bug</user>
		//   <assistant>
		//     <content>I fixed the bug.</content>
		//     <reasoning_content>Let me think...</reasoning_content>
		//     <todo>- [x] read: src/a.js\n- [ ] edit: fix the thing</todo>
		//     <known>The file has a bug</known>
		//     <unknown>Why it was written this way</unknown>
		//     <summary>Fixed a bug in src/a.js</summary>
		//     <meta>{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150,"alias":"opus","actualModel":"claude-opus-4-20250514","displayModel":"Opus"}</meta>
		//   </assistant>
		//   <error source="lint">Lint failed</error>
		//   <warn>Deprecated API usage</warn>
		//   <info>Build succeeded</info>
		// </turn>

		const ins = (params) => db.insert_turn_element.get(params);
		let seq = 0;

		const turnEl = await ins({
			turn_id: turnId,
			parent_id: null,
			tag_name: "turn",
			content: null,
			attributes: JSON.stringify({ sequence: 1 }),
			sequence: seq++,
		});
		const turnElId = turnEl.id;

		await ins({
			turn_id: turnId,
			parent_id: turnElId,
			tag_name: "system",
			content: "You are a helpful assistant.",
			attributes: "{}",
			sequence: seq++,
		});

		// context > files > file > source
		const contextEl = await ins({
			turn_id: turnId,
			parent_id: turnElId,
			tag_name: "context",
			content: null,
			attributes: "{}",
			sequence: seq++,
		});

		const filesEl = await ins({
			turn_id: turnId,
			parent_id: contextEl.id,
			tag_name: "files",
			content: null,
			attributes: "{}",
			sequence: seq++,
		});

		const fileEl = await ins({
			turn_id: turnId,
			parent_id: filesEl.id,
			tag_name: "file",
			content: null,
			attributes: JSON.stringify({
				path: "src/a.js",
				size: "42",
				tokens: "10",
			}),
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: fileEl.id,
			tag_name: "source",
			content: "const a = 1;",
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: turnElId,
			tag_name: "user",
			content: "Fix the bug",
			attributes: "{}",
			sequence: seq++,
		});

		// assistant and children
		const assistantEl = await ins({
			turn_id: turnId,
			parent_id: turnElId,
			tag_name: "assistant",
			content: null,
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: assistantEl.id,
			tag_name: "content",
			content: "I fixed the bug.",
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: assistantEl.id,
			tag_name: "reasoning_content",
			content: "Let me think...",
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: assistantEl.id,
			tag_name: "todo",
			content: "- [x] read: src/a.js\n- [ ] edit: fix the thing",
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: assistantEl.id,
			tag_name: "known",
			content: "The file has a bug",
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: assistantEl.id,
			tag_name: "unknown",
			content: "Why it was written this way",
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: assistantEl.id,
			tag_name: "summary",
			content: "Fixed a bug in src/a.js",
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: assistantEl.id,
			tag_name: "meta",
			content: JSON.stringify({
				prompt_tokens: 100,
				completion_tokens: 50,
				total_tokens: 150,
				alias: "opus",
				actualModel: "claude-opus-4-20250514",
				displayModel: "Opus",
			}),
			attributes: "{}",
			sequence: seq++,
		});

		// Top-level diagnostics
		await ins({
			turn_id: turnId,
			parent_id: turnElId,
			tag_name: "error",
			content: "Lint failed",
			attributes: JSON.stringify({ source: "lint" }),
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: turnElId,
			tag_name: "warn",
			content: "Deprecated API usage",
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: turnElId,
			tag_name: "info",
			content: "Build succeeded",
			attributes: "{}",
			sequence: seq++,
		});
	});

	t.after(async () => {
		await tdb.cleanup();
	});

	await t.test("hydrate() populates data from DB", async () => {
		const turn = new Turn(db, turnId);
		const result = await turn.hydrate();
		assert.strictEqual(result, turn, "hydrate returns this");
		assert.strictEqual(turn.id, turnId);
	});

	await t.test("toJson() throws if not hydrated", () => {
		const turn = new Turn(db, turnId);
		assert.throws(() => turn.toJson(), { message: "Turn not hydrated." });
	});

	await t.test(
		"toJson() returns correct structure with all fields",
		async () => {
			const turn = new Turn(db, turnId);
			await turn.hydrate();
			const json = turn.toJson();

			assert.strictEqual(json.sequence, 1);
			assert.strictEqual(json.system, "You are a helpful assistant.");
			assert.strictEqual(json.user, "Fix the bug");
			assert.ok(json.context.includes("<context>"), "context contains XML");
			assert.ok(
				json.context.includes("src/a.js"),
				"context includes file path",
			);

			// Diagnostics
			assert.strictEqual(json.errors.length, 1);
			assert.strictEqual(json.errors[0].content, "Lint failed");
			assert.strictEqual(json.errors[0].source, "lint");

			assert.strictEqual(json.warnings.length, 1);
			assert.strictEqual(json.warnings[0].content, "Deprecated API usage");

			assert.strictEqual(json.infos.length, 1);
			assert.strictEqual(json.infos[0].content, "Build succeeded");

			// Files
			assert.strictEqual(json.files.length, 1);
			assert.strictEqual(json.files[0].path, "src/a.js");
			assert.strictEqual(json.files[0].size, "42");
			assert.strictEqual(json.files[0].tokens, "10");
			assert.strictEqual(json.files[0].content, "const a = 1;");

			// Assistant
			assert.strictEqual(json.assistant.content, "I fixed the bug.");
			assert.strictEqual(json.assistant.reasoning_content, "Let me think...");
			assert.strictEqual(json.assistant.known, "The file has a bug");
			assert.strictEqual(json.assistant.unknown, "Why it was written this way");
			assert.strictEqual(json.assistant.summary, "Fixed a bug in src/a.js");

			// Usage
			assert.strictEqual(json.usage.prompt_tokens, 100);
			assert.strictEqual(json.usage.completion_tokens, 50);
			assert.strictEqual(json.usage.total_tokens, 150);

			// Model
			assert.strictEqual(json.model.alias, "opus");
			assert.strictEqual(json.model.actual, "claude-opus-4-20250514");
			assert.strictEqual(json.model.display, "Opus");
		},
	);

	await t.test(
		"toJson() todo is parsed by TodoParser with verb support",
		async () => {
			const turn = new Turn(db, turnId);
			await turn.hydrate();
			const json = turn.toJson();

			assert.strictEqual(json.assistant.todo.length, 2);

			const first = json.assistant.todo[0];
			assert.strictEqual(first.tool, "read");
			assert.strictEqual(first.argument, "src/a.js");
			assert.strictEqual(first.completed, true);

			const second = json.assistant.todo[1];
			assert.strictEqual(second.tool, "edit");
			assert.strictEqual(second.argument, "fix the thing");
			assert.strictEqual(second.completed, false);

			// next_todo should be the first incomplete item
			assert.strictEqual(json.assistant.next_todo, second);
		},
	);

	await t.test(
		"serialize() returns system, user (with feedback), assistant messages",
		async () => {
			const turn = new Turn(db, turnId);
			await turn.hydrate();
			const messages = await turn.serialize();

			assert.strictEqual(messages.length, 3);

			assert.strictEqual(messages[0].role, "system");
			assert.ok(
				messages[0].content.includes("helpful assistant"),
				"system message includes identity",
			);

			assert.strictEqual(messages[1].role, "user");
			assert.ok(
				messages[1].content.includes("<user>"),
				"user message includes user XML",
			);
			assert.ok(
				messages[1].content.includes("Fix the bug"),
				"user message includes user text",
			);

			assert.strictEqual(messages[2].role, "assistant");
			assert.strictEqual(messages[2].content, "I fixed the bug.");
		},
	);

	await t.test(
		"serialize({forHistory: true}) omits system and strips context from user",
		async () => {
			const turn = new Turn(db, turnId);
			await turn.hydrate();
			const messages = await turn.serialize({ forHistory: true });

			// No system message
			const roles = messages.map((m) => m.role);
			assert.ok(!roles.includes("system"), "system message is omitted");

			// User message should not include context
			const userMsg = messages.find((m) => m.role === "user");
			assert.ok(userMsg, "user message exists");
			assert.ok(!userMsg.content.includes("<context>"), "context is stripped");
			assert.ok(
				userMsg.content.includes("Fix the bug"),
				"user text is preserved",
			);

			// Assistant still present
			const assistantMsg = messages.find((m) => m.role === "assistant");
			assert.ok(assistantMsg);
			assert.strictEqual(assistantMsg.content, "I fixed the bug.");
		},
	);

	await t.test("toXml() produces valid XML string", async () => {
		const turn = new Turn(db, turnId);
		await turn.hydrate();

		// Default: renders root node
		const xml = turn.toXml();
		assert.ok(xml.startsWith("<turn"), "starts with root tag");
		assert.ok(xml.includes("</turn>"), "ends with closing root tag");
		assert.ok(xml.includes("<system>"), "includes system tag");
		assert.ok(xml.includes("<user>"), "includes user tag");
		assert.ok(xml.includes("<assistant>"), "includes assistant tag");
		assert.ok(xml.includes('sequence="1"'), "includes sequence attribute");
	});

	await t.test("toXml(node) renders a specific subtree", async () => {
		const turn = new Turn(db, turnId);
		await turn.hydrate();
		const json = turn.toJson();

		// context XML should be a subtree
		assert.ok(
			json.context.startsWith("<context>"),
			"context XML starts correctly",
		);
		assert.ok(json.context.includes("<file"), "context includes file element");
		assert.ok(json.context.includes("</context>"), "context XML closes");
	});
});
