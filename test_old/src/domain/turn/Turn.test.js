import assert from "node:assert";
import { randomUUID } from "node:crypto";
import test from "node:test";
import TestDb from "../../../test/helpers/TestDb.js";
import Turn from "./Turn.js";

test("Turn", async (t) => {
	let tdb, db, turnId, sessionId;

	t.before(async () => {
		tdb = await TestDb.create();
		db = tdb.db;

		const projectId = randomUUID();
		sessionId = randomUUID();
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
			alias: "test_1",
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
			assert.ok(
				json.system.includes("helpful assistant"),
				"system has identity",
			);
			assert.ok(json.system.includes("src/a.js"), "system has file path");
			assert.ok(json.system.includes("const a = 1"), "system has file content");
			assert.strictEqual(json.user, "Fix the bug");

			// Context rendered as Markdown
			assert.ok(
				json.context.includes("src/a.js"),
				"context includes file path",
			);
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
			assert.deepStrictEqual(json.assistant.unknown, [
				"Why it was written this way",
			]);
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

	await t.test("toJson() todo is parsed with verb support", async () => {
		const turn = new Turn(db, turnId);
		await turn.hydrate();
		const json = turn.toJson();

		assert.strictEqual(json.assistant.todo.length, 2);
		assert.strictEqual(json.assistant.todo[0].tool, "read");
		assert.strictEqual(json.assistant.todo[0].argument, "src/a.js");
		assert.strictEqual(json.assistant.todo[1].tool, "edit");
		assert.strictEqual(json.assistant.next_todo, json.assistant.todo[0]);
	});

	await t.test(
		"serialize() returns system, user (with context), assistant messages",
		async () => {
			const turn = new Turn(db, turnId);
			await turn.hydrate();
			const messages = await turn.serialize();

			assert.strictEqual(messages.length, 3);

			assert.strictEqual(messages[0].role, "system");
			assert.ok(messages[0].content.includes("helpful assistant"));
			assert.ok(
				messages[0].content.includes("Project Files"),
				"system has documents heading",
			);
			assert.ok(
				messages[0].content.includes("```javascript"),
				"system has code fence",
			);
			assert.ok(
				messages[0].content.includes("const a = 1"),
				"system has file content",
			);

			assert.strictEqual(messages[1].role, "user");
			assert.ok(messages[1].content.includes("Fix the bug"));
			assert.ok(
				messages[1].content.includes("retained"),
				"user has feedback context",
			);

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

	await t.test(
		"renders modified_files and error nodes in context",
		async () => {
			const runId2 = crypto.randomUUID();
			await db.create_run.get({
				id: runId2,
				session_id: sessionId,
				parent_run_id: null,
				type: "ask",
				config: "{}",
				alias: "test_2",
			});
			const turn2Row = await db.create_empty_turn.get({
				run_id: runId2,
				sequence: 0,
			});
			const ins = (params) => db.insert_turn_element.get(params);

			const root2 = await ins({
				turn_id: turn2Row.id,
				parent_id: null,
				tag_name: "turn",
				content: null,
				attributes: JSON.stringify({ sequence: 0 }),
				sequence: 0,
			});
			const sys2 = await ins({
				turn_id: turn2Row.id,
				parent_id: root2.id,
				tag_name: "system",
				content: "Identity.\n",
				attributes: "{}",
				sequence: 1,
			});
			// Document with symbols visibility
			const docs2 = await ins({
				turn_id: turn2Row.id,
				parent_id: sys2.id,
				tag_name: "documents",
				content: null,
				attributes: "{}",
				sequence: 2,
			});
			const symDoc = await ins({
				turn_id: turn2Row.id,
				parent_id: docs2.id,
				tag_name: "document",
				content: null,
				attributes: JSON.stringify({ index: "1", visibility: "symbols" }),
				sequence: 3,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: symDoc.id,
				tag_name: "source",
				content: "lib/utils.py",
				attributes: "{}",
				sequence: 4,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: symDoc.id,
				tag_name: "document_content",
				content: "parse(data), format(out)",
				attributes: "{}",
				sequence: 5,
			});
			// Path-only document
			const pathDoc = await ins({
				turn_id: turn2Row.id,
				parent_id: docs2.id,
				tag_name: "document",
				content: null,
				attributes: JSON.stringify({ index: "2", visibility: "path" }),
				sequence: 6,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: pathDoc.id,
				tag_name: "source",
				content: "README.md",
				attributes: "{}",
				sequence: 7,
			});

			// Context with modified_files, error, and unstructured feedback
			const ctx2 = await ins({
				turn_id: turn2Row.id,
				parent_id: root2.id,
				tag_name: "context",
				content: null,
				attributes: "{}",
				sequence: 8,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: ctx2.id,
				tag_name: "modified_files",
				content: "Modified: lib/utils.py",
				attributes: "{}",
				sequence: 9,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: ctx2.id,
				tag_name: "error",
				content: "Lint failed on utils.py",
				attributes: "{}",
				sequence: 10,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: ctx2.id,
				tag_name: "feedback",
				content: "unstructured line without level prefix",
				attributes: "{}",
				sequence: 10,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: root2.id,
				tag_name: "user",
				content: "hello",
				attributes: "{}",
				sequence: 11,
			});
			// Assistant with code-fenced JSON
			const asst2 = await ins({
				turn_id: turn2Row.id,
				parent_id: root2.id,
				tag_name: "assistant",
				content: null,
				attributes: "{}",
				sequence: 12,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: asst2.id,
				tag_name: "content",
				content:
					'```json\n{"todo":[],"known":[],"unknown":[],"summary":"ok"}\n```',
				attributes: "{}",
				sequence: 13,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: asst2.id,
				tag_name: "meta",
				content: "{}",
				attributes: "{}",
				sequence: 14,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: asst2.id,
				tag_name: "known",
				content: "[]",
				attributes: "{}",
				sequence: 15,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: asst2.id,
				tag_name: "unknown",
				content: "[]",
				attributes: "{}",
				sequence: 16,
			});
			await ins({
				turn_id: turn2Row.id,
				parent_id: asst2.id,
				tag_name: "summary",
				content: "ok",
				attributes: "{}",
				sequence: 17,
			});

			const turn2 = new Turn(db, turn2Row.id);
			await turn2.hydrate();
			const json2 = turn2.toJson();

			// Symbols document
			assert.strictEqual(json2.files[0].path, "lib/utils.py");
			assert.strictEqual(json2.files[0].visibility, "symbols");
			// Path-only document
			assert.strictEqual(json2.files[1].path, "README.md");
			assert.strictEqual(json2.files[1].visibility, "path");

			// Context rendering
			assert.ok(
				json2.context.includes("Modified Files"),
				"renders modified_files heading",
			);
			assert.ok(
				json2.context.includes("lib/utils.py"),
				"renders modified path",
			);

			// Unstructured feedback falls back to info with empty target
			const unstructured = json2.feedback.find((f) =>
				f.message.includes("unstructured"),
			);
			assert.ok(unstructured, "unstructured feedback parsed");
			assert.strictEqual(unstructured.level, "info");
			assert.strictEqual(unstructured.target, "");

			// Code-fence stripping in assistant content
			assert.strictEqual(json2.assistant.summary, "ok");

			// Serialize includes modified_files in context
			const msgs = await turn2.serialize();
			const systemMsg = msgs.find((m) => m.role === "system");
			assert.ok(
				systemMsg.content.includes("symbols"),
				"system has symbols doc",
			);
			assert.ok(
				systemMsg.content.includes("parse(data)"),
				"system has symbol content",
			);
			assert.ok(
				systemMsg.content.includes("`README.md`"),
				"system has path-only doc",
			);
			const userMsg = msgs.find((m) => m.role === "user");
			assert.ok(
				userMsg.content.includes("Modified Files"),
				"user has modified files in context",
			);
			assert.ok(
				userMsg.content.includes("**Error**"),
				"user has error node rendered",
			);
			assert.ok(
				userMsg.content.includes("Lint failed"),
				"error content present",
			);
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
