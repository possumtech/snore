import assert from "node:assert";
import test from "node:test";
import TestDb from "../../../test/helpers/TestDb.js";
import createHooks from "../hooks/Hooks.js";
import TurnBuilder from "./TurnBuilder.js";

test("TurnBuilder", async (t) => {
	let tdb;

	t.before(async () => {
		tdb = await TestDb.create();
		await tdb.db.upsert_project.run({
			id: "p1",
			path: "/tmp/tb-test",
			name: "TBTest",
		});
		await tdb.db.create_session.run({
			id: "s1",
			project_id: "p1",
			client_id: "c1",
		});
		await tdb.db.create_run.run({
			id: "r1",
			session_id: "s1",
			parent_run_id: null,
			type: "ask",
			config: "{}",
		});
	});

	t.after(async () => {
		await tdb.cleanup();
	});

	await t.test(
		"build should create a turn with system, context, user, assistant",
		async () => {
			const turnRow = await tdb.db.create_empty_turn.get({
				run_id: "r1",
				sequence: 0,
			});

			const hooks = createHooks();
			const builder = new TurnBuilder(hooks);
			const turn = await builder.build({
				type: "ask",
				project: { id: "p1", path: "/tmp/tb-test", name: "TBTest" },
				model: "test-model",
				db: tdb.db,
				prompt: "What is 2+2?",
				sequence: 0,
				hasUnknowns: true,
				turnId: turnRow.id,
				runId: "r1",
			});

			const json = turn.toJson();
			assert.ok(
				json.system.includes("You are an assistant"),
				"System should contain identity prompt",
			);
			assert.ok(json.user.includes("2+2"), "User should contain prompt text");
			assert.strictEqual(json.sequence, 0);
		},
	);

	await t.test(
		"build should set protocol constraint attributes on mode tag",
		async () => {
			const turnRow = await tdb.db.create_empty_turn.get({
				run_id: "r1",
				sequence: 1,
			});

			const hooks = createHooks();
			const builder = new TurnBuilder(hooks);
			const turn = await builder.build({
				type: "act",
				project: { id: "p1", path: "/tmp/tb-test", name: "TBTest" },
				model: "test-model",
				db: tdb.db,
				prompt: "Fix the bug.",
				sequence: 1,
				hasUnknowns: false,
				turnId: turnRow.id,
				runId: "r1",
			});

			const msgs = await turn.serialize();
			const userMsg = msgs.find((m) => m.role === "user");
			assert.ok(userMsg, "Should have user message");
			assert.ok(
				userMsg.content.includes("required_tags"),
				"Mode tag should have required_tags attribute",
			);
			assert.ok(
				userMsg.content.includes("allowed_tags"),
				"Mode tag should have allowed_tags attribute",
			);
			assert.ok(
				userMsg.content.includes("edit"),
				"Act mode without unknowns should allow edit",
			);
		},
	);

	await t.test("build should pass noContext to RummyContext", async () => {
		const turnRow = await tdb.db.create_empty_turn.get({
			run_id: "r1",
			sequence: 2,
		});

		let capturedNoContext = null;
		const hooks = createHooks();
		hooks.onTurn(async (rummy) => {
			capturedNoContext = rummy.noContext;
		});

		const builder = new TurnBuilder(hooks);
		await builder.build({
			type: "ask",
			project: { id: "p1", path: "/tmp/tb-test", name: "TBTest" },
			model: "test-model",
			db: tdb.db,
			prompt: "Quick question",
			sequence: 2,
			hasUnknowns: true,
			turnId: turnRow.id,
			runId: "r1",
			noContext: true,
		});

		assert.strictEqual(
			capturedNoContext,
			true,
			"noContext should be passed through to RummyContext",
		);
	});

	await t.test("build should commit turn elements to DB", async () => {
		const turnRow = await tdb.db.create_empty_turn.get({
			run_id: "r1",
			sequence: 3,
		});

		const hooks = createHooks();
		const builder = new TurnBuilder(hooks);
		await builder.build({
			type: "ask",
			project: { id: "p1", path: "/tmp/tb-test", name: "TBTest" },
			model: "test-model",
			db: tdb.db,
			prompt: "Hello",
			sequence: 3,
			hasUnknowns: true,
			turnId: turnRow.id,
			runId: "r1",
		});

		const elements = await tdb.db.get_turn_elements.all({
			turn_id: turnRow.id,
		});
		const tagNames = elements.map((e) => e.tag_name);
		assert.ok(tagNames.includes("turn"), "Should have root turn element");
		assert.ok(tagNames.includes("system"), "Should have system element");
		assert.ok(tagNames.includes("context"), "Should have context element");
		assert.ok(tagNames.includes("user"), "Should have user element");
		assert.ok(tagNames.includes("assistant"), "Should have assistant element");
	});
});
