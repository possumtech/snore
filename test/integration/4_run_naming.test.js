import assert from "node:assert";
import test from "node:test";
import TestDb from "../helpers/TestDb.js";
import createHooks from "../../src/domain/hooks/Hooks.js";
import AgentLoop from "../../src/application/agent/AgentLoop.js";

const mockTurnExecutor = () => ({
	execute: async () => ({
		turnObj: {
			hydrate: async () => {},
			toJson: () => ({ assistant: { content: "", reasoning_content: "", known: "" } }),
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
	evaluate: async () => ({ action: "completed", warnings: [], proposed: [], hasSummary: true }),
});

const mockSessionManager = () => ({
	getFiles: async () => [],
});

test("§4 Run Naming — alias generation and uniqueness", async (t) => {
	let tdb, loop;

	t.before(async () => {
		tdb = await TestDb.create();
		await tdb.db.upsert_project.run({ id: "p1", path: "/tmp/rn-test", name: "RN" });
		await tdb.db.create_session.run({ id: "s1", project_id: "p1", client_id: "c1" });

		const hooks = createHooks();
		loop = new AgentLoop(
			tdb.db, {}, hooks,
			mockTurnExecutor(),
			mockFindingsProcessor(),
			mockStateEvaluator(),
			mockSessionManager(),
		);
	});

	t.after(async () => await tdb.cleanup());

	await t.test("aliases are auto-generated as model_N", async () => {
		const r1 = await loop.run("ask", "s1", null, "first", null, null, {});
		assert.ok(r1.run.endsWith("_1"), `first run should be _1, got ${r1.run}`);

		const r2 = await loop.run("ask", "s1", null, "second", null, null, {});
		assert.ok(r2.run.endsWith("_2"), `second run should be _2, got ${r2.run}`);
	});

	await t.test("aliases are unique", async () => {
		const r3 = await loop.run("ask", "s1", null, "third", null, null, {});
		const r4 = await loop.run("ask", "s1", null, "fourth", null, null, {});
		assert.notStrictEqual(r3.run, r4.run);
	});

	await t.test("fork generates a new alias", async () => {
		const original = await loop.run("ask", "s1", null, "origin", null, null, {});
		const forked = await loop.run("ask", "s1", null, "fork", null, original.run, { fork: true });
		assert.notStrictEqual(forked.run, original.run);
		assert.ok(forked.run.includes("_"), "forked run has alias format");
	});

	await t.test("rename enforces format and uniqueness", async () => {
		const r = await loop.run("ask", "s1", null, "rename test", null, null, {});
		const runRow = await tdb.db.get_run_by_alias.get({ alias: r.run });

		await tdb.db.rename_run.run({ id: runRow.id, old_alias: r.run, new_alias: "my_custom" });
		const renamed = await tdb.db.get_run_by_alias.get({ alias: "my_custom" });
		assert.ok(renamed, "renamed alias should exist");
		assert.strictEqual(renamed.id, runRow.id);

		const oldLookup = await tdb.db.get_run_by_alias.get({ alias: r.run });
		assert.strictEqual(oldLookup, undefined, "old alias should not resolve");
	});

	await t.test("lookup by alias returns correct run", async () => {
		const r = await loop.run("ask", "s1", null, "lookup test", null, null, {});
		const runRow = await tdb.db.get_run_by_alias.get({ alias: r.run });
		assert.ok(runRow);
		assert.strictEqual(runRow.alias, r.run);
		assert.strictEqual(runRow.type, "ask");
	});
});
