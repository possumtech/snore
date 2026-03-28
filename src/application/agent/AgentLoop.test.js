import assert from "node:assert";
import test from "node:test";
import TestDb from "../../../test/helpers/TestDb.js";
import createHooks from "../../domain/hooks/Hooks.js";
import AgentLoop from "./AgentLoop.js";

const mockTurnResult = (overrides = {}) => ({
	turnObj: { hydrate: async () => {}, toJson: () => ({ assistant: { content: "", reasoning_content: "", known: "" } }) },
	turnId: "t1",
	turnSequence: 0,
	tools: [],
	structural: [{ name: "summary", content: "done" }],
	flags: { hasAct: false, hasReads: false, hasSummary: true },
	elements: [],
	finalResponse: { content: "{}" },
	commitTag: async () => {},
	parsedTodo: [],
	...overrides,
});

const mockTurnExecutor = (result) => ({
	execute: async () => result,
});

const mockFindingsProcessor = () => ({
	process: async () => ({ newReads: 0 }),
});

const mockStateEvaluator = (action = "completed") => ({
	evaluate: async () => ({ action, warnings: [], proposed: [], hasSummary: true }),
});

const mockSessionManager = () => ({
	getFiles: async () => [],
});

test("AgentLoop", async (t) => {
	let tdb;

	t.before(async () => {
		tdb = await TestDb.create();
		await tdb.db.upsert_project.run({ id: "p1", path: "/tmp/al-test", name: "ALTest" });
		await tdb.db.create_session.run({ id: "s1", project_id: "p1", client_id: "c1" });
	});

	t.after(async () => {
		await tdb.cleanup();
	});

	await t.test("run should create new run with alias and return completed", async () => {
		const hooks = createHooks();
		const loop = new AgentLoop(
			tdb.db, {}, hooks,
			mockTurnExecutor(mockTurnResult()),
			mockFindingsProcessor(),
			mockStateEvaluator("completed"),
			mockSessionManager(),
		);

		const result = await loop.run("ask", "s1", null, "hello", null, null, {});
		assert.strictEqual(result.status, "completed");
		assert.ok(result.run, "should have run alias");
		assert.ok(result.run.includes("_"), "alias should be model_N format");
	});

	await t.test("run should continue existing run by alias", async () => {
		const hooks = createHooks();
		// First create a run
		const loop = new AgentLoop(
			tdb.db, {}, hooks,
			mockTurnExecutor(mockTurnResult()),
			mockFindingsProcessor(),
			mockStateEvaluator("completed"),
			mockSessionManager(),
		);

		const first = await loop.run("ask", "s1", null, "first", null, null, {});
		// Now continue it
		const second = await loop.run("ask", "s1", null, "second", null, first.run, {});
		assert.strictEqual(second.status, "completed");
		assert.strictEqual(second.run, first.run);
	});

	await t.test("run should fork from existing run", async () => {
		const hooks = createHooks();
		const loop = new AgentLoop(
			tdb.db, {}, hooks,
			mockTurnExecutor(mockTurnResult()),
			mockFindingsProcessor(),
			mockStateEvaluator("completed"),
			mockSessionManager(),
		);

		const original = await loop.run("ask", "s1", null, "original", null, null, {});
		const forked = await loop.run("ask", "s1", null, "forked", null, original.run, { fork: true });
		assert.strictEqual(forked.status, "completed");
		assert.notStrictEqual(forked.run, original.run, "fork should have new alias");
	});

	await t.test("run should return proposed when findings exist", async () => {
		const hooks = createHooks();
		const loop = new AgentLoop(
			tdb.db, {}, hooks,
			mockTurnExecutor(mockTurnResult()),
			mockFindingsProcessor(),
			mockStateEvaluator("proposed"),
			mockSessionManager(),
		);

		const result = await loop.run("act", "s1", null, "edit something", null, null, {});
		assert.strictEqual(result.status, "proposed");
	});

	await t.test("run should handle noContext option", async () => {
		const hooks = createHooks();
		const loop = new AgentLoop(
			tdb.db, {}, hooks,
			mockTurnExecutor(mockTurnResult()),
			mockFindingsProcessor(),
			mockStateEvaluator("completed"),
			mockSessionManager(),
		);

		const result = await loop.run("ask", "s1", null, "quick", null, null, { noContext: true });
		assert.strictEqual(result.status, "completed");
	});

	await t.test("inject on idle run should resume", async () => {
		const hooks = createHooks();
		const loop = new AgentLoop(
			tdb.db, {}, hooks,
			mockTurnExecutor(mockTurnResult()),
			mockFindingsProcessor(),
			mockStateEvaluator("completed"),
			mockSessionManager(),
		);

		const original = await loop.run("ask", "s1", null, "start", null, null, {});
		const result = await loop.inject(original.run, "btw check this");
		assert.strictEqual(result.status, "completed");
		assert.strictEqual(result.run, original.run);
	});

	await t.test("inject on active run should queue", async () => {
		const hooks = createHooks();
		// Create a run and set it to running status
		const loop = new AgentLoop(
			tdb.db, {}, hooks,
			mockTurnExecutor(mockTurnResult()),
			mockFindingsProcessor(),
			mockStateEvaluator("completed"),
			mockSessionManager(),
		);

		const original = await loop.run("ask", "s1", null, "start", null, null, {});
		// Manually set status back to running
		const runRow = await tdb.db.get_run_by_alias.get({ alias: original.run });
		await tdb.db.update_run_status.run({ id: runRow.id, status: "running" });

		const result = await loop.inject(original.run, "btw");
		assert.strictEqual(result.injected, "queued");
	});

	await t.test("run should throw for non-existent alias", async () => {
		const hooks = createHooks();
		const loop = new AgentLoop(
			tdb.db, {}, hooks,
			mockTurnExecutor(mockTurnResult()),
			mockFindingsProcessor(),
			mockStateEvaluator("completed"),
			mockSessionManager(),
		);

		await assert.rejects(
			loop.run("ask", "s1", null, "hi", null, "nonexistent_99", {}),
			/not found/,
		);
	});
});
