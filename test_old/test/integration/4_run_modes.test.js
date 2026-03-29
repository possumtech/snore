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

const mockStateEvaluator = () => ({
	evaluate: async () => ({
		action: "completed",
		warnings: [],
		proposed: [],
		hasSummary: true,
	}),
});

const mockSessionManager = () => ({
	getFiles: async () => [],
});

test("§4.4 Run Modes — continue, new, lite, fork", async (t) => {
	let tdb, loop;

	t.before(async () => {
		tdb = await TestDb.create();
		await tdb.db.upsert_project.run({
			id: "p1",
			path: "/tmp/rm-test",
			name: "RM",
		});
		await tdb.db.create_session.run({
			id: "s1",
			project_id: "p1",
			client_id: "c1",
		});

		const hooks = createHooks();
		loop = new AgentLoop(
			tdb.db,
			{ getContextSize: async () => 8192 },
			hooks,
			mockTurnExecutor(),
			mockFindingsProcessor(),
			mockStateEvaluator(),
			mockSessionManager(),
		);
	});

	t.after(async () => await tdb.cleanup());

	await t.test("continue: same run, same alias", async () => {
		const first = await loop.run("ask", "s1", null, "start", null, null, {});
		const continued = await loop.run(
			"ask",
			"s1",
			null,
			"continue",
			null,
			first.run,
			{},
		);
		assert.strictEqual(continued.run, first.run, "alias stays the same");
	});

	await t.test("new: fresh run, new alias", async () => {
		const first = await loop.run("ask", "s1", null, "first", null, null, {});
		const second = await loop.run("ask", "s1", null, "second", null, null, {});
		assert.notStrictEqual(
			second.run,
			first.run,
			"new run gets different alias",
		);
	});

	await t.test("lite: noContext flag set", async () => {
		const result = await loop.run("ask", "s1", null, "quick", null, null, {
			noContext: true,
		});
		assert.strictEqual(result.status, "completed");
		// Verify config stored noContext
		const runRow = await tdb.db.get_run_by_alias.get({ alias: result.run });
		const config = JSON.parse(runRow.config || "{}");
		assert.strictEqual(config.noContext, true);
	});

	await t.test("fork: new run with parent pointer", async () => {
		const original = await loop.run(
			"ask",
			"s1",
			null,
			"origin",
			null,
			null,
			{},
		);
		const forked = await loop.run(
			"ask",
			"s1",
			null,
			"fork",
			null,
			original.run,
			{ fork: true },
		);

		assert.notStrictEqual(forked.run, original.run);
		const forkedRow = await tdb.db.get_run_by_alias.get({ alias: forked.run });
		const originalRow = await tdb.db.get_run_by_alias.get({
			alias: original.run,
		});
		assert.strictEqual(
			forkedRow.parent_run_id,
			originalRow.id,
			"fork points to parent",
		);
	});

	await t.test("fork: non-existent run throws", async () => {
		await assert.rejects(
			loop.run("ask", "s1", null, "fork", null, "nonexistent_99", {
				fork: true,
			}),
			/not found/,
		);
	});
});
