import assert from "node:assert";
import crypto from "node:crypto";
import test from "node:test";
import { DOMImplementation } from "@xmldom/xmldom";
import TestDb from "../../../../test/helpers/TestDb.js";
import createHooks from "../../../domain/hooks/Hooks.js";
import RummyContext from "../../../domain/turn/RummyContext.js";
import ContextPlugin from "./context.js";

const dom = new DOMImplementation();

function getFeedbackText(rummy) {
	const feedbackEls = rummy.contextEl.getElementsByTagName("feedback");
	if (feedbackEls.length === 0) return "";
	return feedbackEls[0].textContent || "";
}

async function setup() {
	const tdb = await TestDb.create();
	const projectId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();
	const runId = crypto.randomUUID();

	await tdb.db.upsert_project.run({ id: projectId, path: "/tmp/ctx-test", name: "T" });
	await tdb.db.create_session.run({ id: sessionId, project_id: projectId, client_id: "c1" });
	await tdb.db.create_run.run({ id: runId, session_id: sessionId, parent_run_id: null, type: "ask", config: "{}" });
	const turnRow = await tdb.db.create_empty_turn.get({ run_id: runId, sequence: 0 });

	return { tdb, runId, turnId: turnRow.id };
}

function makeRummy(db, runId, turnId) {
	const doc = dom.createDocument(null, "turn", null);
	const contextEl = doc.createElement("context");
	doc.documentElement.appendChild(contextEl);
	return new RummyContext(doc, { db, project: {}, type: "ask", sequence: 0, runId, turnId });
}

test("ContextPlugin", async (t) => {
	await t.test("should inject info for accepted diff resolution", async () => {
		const { tdb, runId, turnId } = await setup();
		await tdb.db.insert_pending_context.run({
			run_id: runId, source_turn_id: turnId, type: "diff",
			request: "src/app.js", result: "edits accepted", is_error: 0,
		});

		const hooks = createHooks();
		ContextPlugin.register(hooks);
		const rummy = makeRummy(tdb.db, runId, turnId);
		await hooks.processTurn(rummy);

		const feedback = getFeedbackText(rummy);
		assert.ok(feedback.includes("info: src/app.js # edits accepted"));
		await tdb.cleanup();
	});

	await t.test("should inject warn for rejected diff resolution", async () => {
		const { tdb, runId, turnId } = await setup();
		await tdb.db.insert_pending_context.run({
			run_id: runId, source_turn_id: turnId, type: "diff",
			request: "src/app.js", result: "edits rejected", is_error: 0,
		});

		const hooks = createHooks();
		ContextPlugin.register(hooks);
		const rummy = makeRummy(tdb.db, runId, turnId);
		await hooks.processTurn(rummy);

		const feedback = getFeedbackText(rummy);
		assert.ok(feedback.includes("warn: src/app.js # edits rejected"));
		await tdb.cleanup();
	});

	await t.test("should inject info for successful command", async () => {
		const { tdb, runId, turnId } = await setup();
		await tdb.db.insert_pending_context.run({
			run_id: runId, source_turn_id: turnId, type: "command",
			request: "df -h", result: "50G available", is_error: 0,
		});

		const hooks = createHooks();
		ContextPlugin.register(hooks);
		const rummy = makeRummy(tdb.db, runId, turnId);
		await hooks.processTurn(rummy);

		const feedback = getFeedbackText(rummy);
		assert.ok(feedback.includes("info: df -h # 50G available"));
		await tdb.cleanup();
	});

	await t.test("should inject error for failed command (is_error=1)", async () => {
		const { tdb, runId, turnId } = await setup();
		await tdb.db.insert_pending_context.run({
			run_id: runId, source_turn_id: turnId, type: "command",
			request: "npm test", result: "3 tests failed", is_error: 1,
		});

		const hooks = createHooks();
		ContextPlugin.register(hooks);
		const rummy = makeRummy(tdb.db, runId, turnId);
		await hooks.processTurn(rummy);

		const feedback = getFeedbackText(rummy);
		assert.ok(feedback.includes("error: npm test # 3 tests failed"));
		await tdb.cleanup();
	});

	await t.test("should inject info for notification resolution", async () => {
		const { tdb, runId, turnId } = await setup();
		await tdb.db.insert_pending_context.run({
			run_id: runId, source_turn_id: turnId, type: "notification",
			request: "What OS?", result: "Linux", is_error: 0,
		});

		const hooks = createHooks();
		ContextPlugin.register(hooks);
		const rummy = makeRummy(tdb.db, runId, turnId);
		await hooks.processTurn(rummy);

		const feedback = getFeedbackText(rummy);
		assert.ok(feedback.includes("info: What OS? # Linux"));
		await tdb.cleanup();
	});

	await t.test("should mark pending_context as consumed", async () => {
		const { tdb, runId, turnId } = await setup();
		await tdb.db.insert_pending_context.run({
			run_id: runId, source_turn_id: turnId, type: "diff",
			request: "a.js", result: "accepted", is_error: 0,
		});

		const hooks = createHooks();
		ContextPlugin.register(hooks);
		const rummy = makeRummy(tdb.db, runId, turnId);
		await hooks.processTurn(rummy);

		const remaining = await tdb.db.get_pending_context.all({ run_id: runId });
		assert.strictEqual(remaining.length, 0, "Should be consumed");
		await tdb.cleanup();
	});

	await t.test("should skip gracefully when no pending context", async () => {
		const { tdb, runId, turnId } = await setup();

		const hooks = createHooks();
		ContextPlugin.register(hooks);
		const rummy = makeRummy(tdb.db, runId, turnId);
		await hooks.processTurn(rummy);

		const feedback = getFeedbackText(rummy);
		assert.strictEqual(feedback, "");
		await tdb.cleanup();
	});
});
