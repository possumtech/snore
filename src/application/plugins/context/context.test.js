import assert from "node:assert";
import crypto from "node:crypto";
import test from "node:test";
import { DOMImplementation } from "@xmldom/xmldom";
import TestDb from "../../../../test/helpers/TestDb.js";
import createHooks from "../../../domain/hooks/Hooks.js";
import RummyContext from "../../../domain/turn/RummyContext.js";
import ContextPlugin from "./context.js";

const dom = new DOMImplementation();

const setup = async () => {
	const testDb = await TestDb.create();
	const { db } = testDb;

	const projectId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();
	const runId = crypto.randomUUID();

	await db.upsert_project.get({ id: projectId, path: "/tmp/ctx-test", name: "ctx-test" });
	await db.create_session.run({ id: sessionId, project_id: projectId, client_id: "c1" });
	await db.create_run.run({
		id: runId,
		session_id: sessionId,
		parent_run_id: null,
		type: "act",
		config: null,
	});
	const turn = await db.create_empty_turn.get({ run_id: runId, sequence: 1 });
	const turnId = turn.id;

	return { testDb, db, projectId, sessionId, runId, turnId };
};

const buildRummy = (db, runId, turnId) => {
	const doc = dom.createDocument(null, "turn", null);
	const contextEl = doc.createElement("context");
	doc.documentElement.appendChild(contextEl);

	return new RummyContext(doc, {
		db,
		project: { id: "p1", path: "/tmp/test", name: "test" },
		runId,
		turnId,
	});
};

test("ContextPlugin", async (t) => {
	await t.test(
		"should inject <info> tag for accepted diff resolution",
		async () => {
			const { testDb, db, runId, turnId } = await setup();
			t.after(() => testDb.cleanup());

			await db.insert_pending_context.run({
				run_id: runId,
				source_turn_id: turnId,
				type: "diff",
				request: "src/app.js",
				result: "edits accepted",
				is_error: 0,
			});

			const rummy = buildRummy(db, runId, turnId);
			const hooks = createHooks();
			ContextPlugin.register(hooks);
			await hooks.processTurn(rummy);

			const infos = rummy.contextEl.getElementsByTagName("info");
			assert.strictEqual(infos.length, 1);
			assert.strictEqual(infos[0].getAttribute("file"), "src/app.js");
			assert.strictEqual(infos[0].textContent, "edits accepted");
		},
	);

	await t.test(
		"should inject <warn> tag for rejected diff resolution",
		async () => {
			const { testDb, db, runId, turnId } = await setup();
			t.after(() => testDb.cleanup());

			await db.insert_pending_context.run({
				run_id: runId,
				source_turn_id: turnId,
				type: "diff",
				request: "src/app.js",
				result: "edits rejected by user",
				is_error: 0,
			});

			const rummy = buildRummy(db, runId, turnId);
			const hooks = createHooks();
			ContextPlugin.register(hooks);
			await hooks.processTurn(rummy);

			const warns = rummy.contextEl.getElementsByTagName("warn");
			assert.strictEqual(warns.length, 1);
			assert.strictEqual(warns[0].getAttribute("file"), "src/app.js");
			assert.strictEqual(warns[0].textContent, "edits rejected by user");
		},
	);

	await t.test(
		"should inject <info command> for successful command",
		async () => {
			const { testDb, db, runId, turnId } = await setup();
			t.after(() => testDb.cleanup());

			await db.insert_pending_context.run({
				run_id: runId,
				source_turn_id: turnId,
				type: "command",
				request: "npm test",
				result: "all tests passed",
				is_error: 0,
			});

			const rummy = buildRummy(db, runId, turnId);
			const hooks = createHooks();
			ContextPlugin.register(hooks);
			await hooks.processTurn(rummy);

			const infos = rummy.contextEl.getElementsByTagName("info");
			assert.strictEqual(infos.length, 1);
			assert.strictEqual(infos[0].getAttribute("command"), "npm test");
			assert.strictEqual(infos[0].getAttribute("type"), "command");
			assert.strictEqual(infos[0].textContent, "all tests passed");
		},
	);

	await t.test(
		"should inject <error command> for failed command (is_error=1)",
		async () => {
			const { testDb, db, runId, turnId } = await setup();
			t.after(() => testDb.cleanup());

			await db.insert_pending_context.run({
				run_id: runId,
				source_turn_id: turnId,
				type: "command",
				request: "npm test",
				result: "exit code 1",
				is_error: 1,
			});

			const rummy = buildRummy(db, runId, turnId);
			const hooks = createHooks();
			ContextPlugin.register(hooks);
			await hooks.processTurn(rummy);

			const errors = rummy.contextEl.getElementsByTagName("error");
			assert.strictEqual(errors.length, 1);
			assert.strictEqual(errors[0].getAttribute("command"), "npm test");
			assert.strictEqual(errors[0].getAttribute("type"), "command");
			assert.strictEqual(errors[0].textContent, "exit code 1");
		},
	);

	await t.test(
		"should inject <info prompt> for notification resolution",
		async () => {
			const { testDb, db, runId, turnId } = await setup();
			t.after(() => testDb.cleanup());

			await db.insert_pending_context.run({
				run_id: runId,
				source_turn_id: turnId,
				type: "notification",
				request: "Confirm deploy?",
				result: "user confirmed",
				is_error: 0,
			});

			const rummy = buildRummy(db, runId, turnId);
			const hooks = createHooks();
			ContextPlugin.register(hooks);
			await hooks.processTurn(rummy);

			const infos = rummy.contextEl.getElementsByTagName("info");
			assert.strictEqual(infos.length, 1);
			assert.strictEqual(infos[0].getAttribute("prompt"), "Confirm deploy?");
			assert.strictEqual(infos[0].textContent, "user confirmed");
		},
	);

	await t.test(
		"should mark pending_context as consumed after injection",
		async () => {
			const { testDb, db, runId, turnId } = await setup();
			t.after(() => testDb.cleanup());

			await db.insert_pending_context.run({
				run_id: runId,
				source_turn_id: turnId,
				type: "diff",
				request: "src/app.js",
				result: "edits accepted",
				is_error: 0,
			});

			const rummy = buildRummy(db, runId, turnId);
			const hooks = createHooks();
			ContextPlugin.register(hooks);
			await hooks.processTurn(rummy);

			// After consumption, get_pending_context should return empty
			const remaining = await db.get_pending_context.all({ run_id: runId });
			assert.strictEqual(remaining.length, 0);
		},
	);

	await t.test("should skip if no pending context exists", async () => {
		const { testDb, db, runId, turnId } = await setup();
		t.after(() => testDb.cleanup());

		const rummy = buildRummy(db, runId, turnId);
		const hooks = createHooks();
		ContextPlugin.register(hooks);
		await hooks.processTurn(rummy);

		assert.strictEqual(rummy.contextEl.childNodes.length, 0);
	});
});
