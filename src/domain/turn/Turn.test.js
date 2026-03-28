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

		const turn = await db.create_empty_turn.get({ run_id: runId, sequence: 1 });
		turnId = turn.id;

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

		// System with documents child
		const systemEl = await ins({
			turn_id: turnId,
			parent_id: turnElId,
			tag_name: "system",
			content: "You are a helpful assistant.\n",
			attributes: "{}",
			sequence: seq++,
		});

		const docsEl = await ins({
			turn_id: turnId,
			parent_id: systemEl.id,
			tag_name: "documents",
			content: null,
			attributes: "{}",
			sequence: seq++,
		});

		const docEl = await ins({
			turn_id: turnId,
			parent_id: docsEl.id,
			tag_name: "document",
			content: null,
			attributes: JSON.stringify({ index: "1", visibility: "full" }),
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: docEl.id,
			tag_name: "source",
			content: "src/a.js",
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: docEl.id,
			tag_name: "document_content",
			content: "const a = 1;",
			attributes: "{}",
			sequence: seq++,
		});

		// Context with feedback
		const contextEl = await ins({
			turn_id: turnId,
			parent_id: turnElId,
			tag_name: "context",
			content: null,
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: contextEl.id,
			tag_name: "feedback",
			content: "info: src/a.js # file retained",
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

		// Assistant and children
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
			content: JSON.stringify({
				todo: [
					{ tool: "read", argument: "src/a.js", description: "check file" },
					{ tool: "edit", argument: "fix the thing", description: "fix bug" },
				],
				known: ["The file has a bug"],
				unknown: ["Why it was written this way"],
				summary: "Fixed a bug in src/a.js",
			}),
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
			tag_name: "known",
			content: JSON.stringify(["The file has a bug"]),
			attributes: "{}",
			sequence: seq++,
		});

		await ins({
			turn_id: turnId,
			parent_id: assistantEl.id,
			tag_name: "unknown",
			content: JSON.stringify(["Why it was written this way"]),
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
			assert.ok(json.system.includes("helpful assistant"), "system has identity");
			assert.ok(json.system.includes("src/a.js"), "system has file path");
			assert.ok(json.system.includes("const a = 1"), "system has file content");
			assert.strictEqual(json.user, "Fix the bug");

			// Context rendered as Markdown
			assert.ok(json.context.includes("src/a.js"), "context includes file path");
			assert.ok(json.context.includes("retained"), "context includes feedback");

			// Diagnostics
			assert.strictEqual(json.errors.length, 1);
			assert.strictEqual(json.errors[0].content, "Lint failed");
			assert.strictEqual(json.errors[0].source, "lint");

			assert.strictEqual(json.warnings.length, 1);
			assert.strictEqual(json.warnings[0].content, "Deprecated API usage");

			assert.strictEqual(json.infos.length, 1);
			assert.strictEqual(json.infos[0].content, "Build succeeded");

			// Files (from document tags)
			assert.strictEqual(json.files.length, 1);
			assert.strictEqual(json.files[0].path, "src/a.js");
			assert.strictEqual(json.files[0].visibility, "full");
			assert.strictEqual(json.files[0].content, "const a = 1;");

			// Assistant
			assert.ok(json.assistant.content.includes("read"));
			assert.strictEqual(json.assistant.reasoning_content, "Let me think...");
			assert.deepStrictEqual(json.assistant.known, ["The file has a bug"]);
			assert.deepStrictEqual(json.assistant.unknown, ["Why it was written this way"]);
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
		"toJson() todo is parsed with verb support",
		async () => {
			const turn = new Turn(db, turnId);
			await turn.hydrate();
			const json = turn.toJson();

			assert.strictEqual(json.assistant.todo.length, 2);
			assert.strictEqual(json.assistant.todo[0].tool, "read");
			assert.strictEqual(json.assistant.todo[0].argument, "src/a.js");
			assert.strictEqual(json.assistant.todo[1].tool, "edit");
			assert.strictEqual(json.assistant.next_todo, json.assistant.todo[0]);
		},
	);

	await t.test(
		"serialize() returns system, user (with context), assistant messages",
		async () => {
			const turn = new Turn(db, turnId);
			await turn.hydrate();
			const messages = await turn.serialize();

			assert.strictEqual(messages.length, 3);

			assert.strictEqual(messages[0].role, "system");
			assert.ok(messages[0].content.includes("helpful assistant"));
			assert.ok(messages[0].content.includes("Project Files"), "system has documents heading");
			assert.ok(messages[0].content.includes("```javascript"), "system has code fence");
			assert.ok(messages[0].content.includes("const a = 1"), "system has file content");

			assert.strictEqual(messages[1].role, "user");
			assert.ok(messages[1].content.includes("Fix the bug"));
			assert.ok(messages[1].content.includes("retained"), "user has feedback context");

			assert.strictEqual(messages[2].role, "assistant");
		},
	);

	await t.test(
		"serialize({forHistory: true}) omits system and strips context",
		async () => {
			const turn = new Turn(db, turnId);
			await turn.hydrate();
			const messages = await turn.serialize({ forHistory: true });

			const roles = messages.map((m) => m.role);
			assert.ok(!roles.includes("system"), "system is omitted");

			const userMsg = messages.find((m) => m.role === "user");
			assert.ok(userMsg);
			assert.ok(userMsg.content.includes("Fix the bug"));
			assert.ok(!userMsg.content.includes("retained"), "context is stripped");

			const assistantMsg = messages.find((m) => m.role === "assistant");
			assert.ok(assistantMsg);
		},
	);

	await t.test("feedback is parsed into structured entries", async () => {
		const turn = new Turn(db, turnId);
		await turn.hydrate();
		const json = turn.toJson();

		assert.ok(json.feedback.length > 0, "should have feedback entries");
		const entry = json.feedback.find((f) => f.target === "src/a.js");
		assert.ok(entry, "should have feedback for src/a.js");
		assert.strictEqual(entry.level, "info");
		assert.ok(entry.message.includes("retained"));
	});
});
