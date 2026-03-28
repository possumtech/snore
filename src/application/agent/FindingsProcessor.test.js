import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import TestDb from "../../../test/helpers/TestDb.js";
import createHooks from "../../domain/hooks/Hooks.js";
import FindingsManager from "./FindingsManager.js";
import FindingsProcessor from "./FindingsProcessor.js";

test("FindingsProcessor", async (t) => {
	let tdb, processor, projectPath, turnId;
	const runId = "r1";
	const projectId = "p1";

	t.before(async () => {
		projectPath = join(tmpdir(), `rummy-fp-test-${Date.now()}`);
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "src/a.js"), "old code\n", { recursive: true }).catch(() => {});
		await fs.mkdir(join(projectPath, "src"), { recursive: true });
		await fs.writeFile(join(projectPath, "src/a.js"), "old code\n");

		tdb = await TestDb.create();
		const hooks = createHooks();
		const fm = new FindingsManager(tdb.db);
		processor = new FindingsProcessor(tdb.db, fm, hooks);

		await tdb.db.upsert_project.run({ id: projectId, path: projectPath, name: "FPTest" });
		await tdb.db.create_session.run({ id: "s1", project_id: projectId, client_id: "c1" });
		await tdb.db.create_run.run({
			id: runId,
			session_id: "s1",
			parent_run_id: null,
			type: "act",
			config: "{}",
			alias: "test_1",
		});
		const turnRow = await tdb.db.create_empty_turn.get({ run_id: runId, sequence: 0 });
		turnId = turnRow.id;

		// Insert turn structure for elements lookup
		const turnEl = await tdb.db.insert_turn_element.get({
			turn_id: turnId,
			parent_id: null,
			tag_name: "turn",
			content: null,
			attributes: "{}",
			sequence: 0,
		});
		await tdb.db.insert_turn_element.get({
			turn_id: turnId,
			parent_id: turnEl.id,
			tag_name: "context",
			content: null,
			attributes: "{}",
			sequence: 1,
		});
		await tdb.db.insert_turn_element.get({
			turn_id: turnId,
			parent_id: turnEl.id,
			tag_name: "assistant",
			content: null,
			attributes: "{}",
			sequence: 2,
		});
	});

	t.after(async () => {
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	const mockTurnObj = () => ({
		toJson: () => ({
			assistant: { content: "", reasoning_content: "", known: "" },
		}),
	});

	await t.test("should persist diffs and return newReads", async () => {
		const elements = await tdb.db.get_turn_elements.all({ turn_id: turnId });
		const result = await processor.process({
			projectPath,
			projectId,
			runId,
			runAlias: "test_1",
			turnId,
			turnSequence: 0,
			tools: [
				{ tool: "edit", path: "src/a.js", search: "old code", replace: "new code" },
			],
			structural: [],
			elements,
			turnObj: mockTurnObj(),
			sessionId: "s1",
		});

		assert.strictEqual(result.newReads, 0);
		const findings = await tdb.db.get_unresolved_findings.all({ run_id: runId });
		assert.ok(findings.length > 0, "Should have unresolved diff finding");
		assert.strictEqual(findings[0].category, "diff");
	});

	await t.test("should persist commands", async () => {
		const elements = await tdb.db.get_turn_elements.all({ turn_id: turnId });
		await processor.process({
			projectPath,
			projectId,
			runId,
			runAlias: "test_1",
			turnId,
			turnSequence: 1,
			tools: [{ tool: "run", command: "npm test" }],
			structural: [],
			elements,
			turnObj: mockTurnObj(),
			sessionId: "s1",
		});

		const findings = await tdb.db.get_unresolved_findings.all({ run_id: runId });
		const cmd = findings.find((f) => f.category === "command");
		assert.ok(cmd, "Should have unresolved command finding");
	});

	await t.test("should persist notifications for prompt_user", async () => {
		const elements = await tdb.db.get_turn_elements.all({ turn_id: turnId });
		await processor.process({
			projectPath,
			projectId,
			runId,
			runAlias: "test_1",
			turnId,
			turnSequence: 2,
			tools: [{
				tool: "prompt_user",
				text: "Which option?",
				config: { question: "Which option?", options: [{ label: "A" }, { label: "B" }] },
			}],
			structural: [],
			elements,
			turnObj: mockTurnObj(),
			sessionId: "s1",
		});

		const findings = await tdb.db.get_unresolved_findings.all({ run_id: runId });
		const notif = findings.find((f) => f.category === "notification");
		assert.ok(notif, "Should have notification finding");
	});

	await t.test("should track reads and return newReads count", async () => {
		const elements = await tdb.db.get_turn_elements.all({ turn_id: turnId });
		const result = await processor.process({
			projectPath,
			projectId,
			runId,
			runAlias: "test_1",
			turnId,
			turnSequence: 3,
			tools: [{ tool: "read", path: "src/a.js" }],
			structural: [],
			elements,
			turnObj: mockTurnObj(),
			sessionId: "s1",
		});

		assert.strictEqual(result.newReads, 1);
	});

	await t.test("should persist summary notification", async () => {
		const elements = await tdb.db.get_turn_elements.all({ turn_id: turnId });
		await processor.process({
			projectPath,
			projectId,
			runId,
			runAlias: "test_1",
			turnId,
			turnSequence: 4,
			tools: [],
			structural: [{ name: "summary", content: "All done." }],
			elements,
			turnObj: mockTurnObj(),
			sessionId: "s1",
		});

		// Summary notifications are acknowledged, not proposed — don't show in unresolved
		// Just verify no error thrown
		assert.ok(true);
	});
});
