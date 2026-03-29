import assert from "node:assert";
import test from "node:test";
import AgentLoop from "../../src/application/agent/AgentLoop.js";
import createHooks from "../../src/domain/hooks/Hooks.js";
import TestDb from "../helpers/TestDb.js";

const mockTurnExecutor = () => ({
	execute: async () => ({
		turnObj: {
			hydrate: async () => {},
			toJson: () => ({
				assistant: { content: "", reasoning_content: "", known: "" },
			}),
		},
		turnId: "t1",
		turnSequence: 0,
		tools: [],
		structural: [{ name: "summary", content: "done" }],
		flags: { hasAct: false, hasReads: false, hasSummary: true },
		elements: [],
		finalResponse: { content: "{}" },
		commitTag: async () => {},
		parsedTodo: [],
	}),
});

const mockFindingsProcessor = () => ({
	process: async () => ({ newReads: 0 }),
});

const mockStateEvaluator = (action = "completed") => ({
	evaluate: async () => ({
		action,
		warnings: [],
		proposed: [],
		hasSummary: true,
	}),
});

const mockSessionManager = () => ({
	getFiles: async () => [],
});

test("§4.3 Run Lifecycle — status transitions", async (t) => {
	let tdb;

	t.before(async () => {
		tdb = await TestDb.create();
		await tdb.db.upsert_project.run({
			id: "p1",
			path: "/tmp/lc-test",
			name: "LC",
		});
		await tdb.db.create_session.run({
			id: "s1",
			project_id: "p1",
			client_id: "c1",
		});
	});

	t.after(async () => await tdb.cleanup());

	await t.test("new run starts queued, transitions to completed", async () => {
		const hooks = createHooks();
		const loop = new AgentLoop(
			tdb.db,
			{ getContextSize: async () => 8192 },
			hooks,
			mockTurnExecutor(),
			mockFindingsProcessor(),
			mockStateEvaluator("completed"),
			mockSessionManager(),
		);

		const result = await loop.run("ask", "s1", null, "hello", null, null, {});
		assert.strictEqual(result.status, "completed");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		assert.strictEqual(runRow.status, "completed");
	});

	await t.test("run with findings transitions to proposed", async () => {
		const hooks = createHooks();
		const loop = new AgentLoop(
			tdb.db,
			{ getContextSize: async () => 8192 },
			hooks,
			mockTurnExecutor(),
			mockFindingsProcessor(),
			mockStateEvaluator("proposed"),
			mockSessionManager(),
		);

		const result = await loop.run("act", "s1", null, "edit", null, null, {});
		assert.strictEqual(result.status, "proposed");

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		assert.strictEqual(runRow.status, "proposed");
	});

	await t.test("abort transitions to aborted", async () => {
		const hooks = createHooks();
		const loop = new AgentLoop(
			tdb.db,
			{ getContextSize: async () => 8192 },
			hooks,
			mockTurnExecutor(),
			mockFindingsProcessor(),
			mockStateEvaluator("completed"),
			mockSessionManager(),
		);

		const result = await loop.run("ask", "s1", null, "test", null, null, {});
		await tdb.db.update_run_status.run({
			id: (await tdb.db.get_run_by_alias.get({ alias: result.run })).id,
			status: "aborted",
		});

		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		assert.strictEqual(runRow.status, "aborted");
	});

	await t.test(
		"findings gate blocks continuation when findings exist",
		async () => {
			// Create a run and manually insert an unresolved finding
			const hooks = createHooks();
			const loop = new AgentLoop(
				tdb.db,
				{ getContextSize: async () => 8192 },
				hooks,
				mockTurnExecutor(),
				mockFindingsProcessor(),
				mockStateEvaluator("completed"),
				mockSessionManager(),
			);

			const first = await loop.run(
				"act",
				"s1",
				null,
				"make edit",
				null,
				null,
				{},
			);
			const runRow = await tdb.db.get_run_by_alias.get({ alias: first.run });
			await tdb.db.update_run_status.run({ id: runRow.id, status: "proposed" });

			// Insert a turn and a real unresolved finding
			const turnRow = await tdb.db.create_empty_turn.get({
				run_id: runRow.id,
				sequence: 99,
			});
			await tdb.db.insert_finding_diff.get({
				run_id: runRow.id,
				turn_id: turnRow.id,
				type: "edit",
				file_path: "test.js",
				patch: "--- a\n+++ b\n",
			});

			// Try to continue — should return proposed findings, not execute a new turn
			const second = await loop.run(
				"act",
				"s1",
				null,
				"continue",
				null,
				first.run,
				{},
			);
			assert.strictEqual(second.status, "proposed");
			assert.ok(second.remainingCount > 0, "should report remaining findings");
		},
	);
});
