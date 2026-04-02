/**
 * Message assembly integration test.
 *
 * Verifies what we actually send to the model by populating known_entries,
 * materializing turn_context, and assembling the messages. Inspects the
 * system and user message content directly.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import ContextAssembler from "../../src/agent/ContextAssembler.js";
import KnownStore from "../../src/agent/KnownStore.js";
import HookRegistry from "../../src/hooks/HookRegistry.js";
import RummyContext from "../../src/hooks/RummyContext.js";
import Engine from "../../src/plugins/engine/engine.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;
let PROJECT;
const TURN = 1;

function makeRummy(db, store, { sequence = TURN, contextSize = 50000 } = {}) {
	const hookRoot = {
		tag: "turn",
		attrs: {},
		content: null,
		children: [
			{ tag: "system", attrs: {}, content: null, children: [] },
			{ tag: "context", attrs: {}, content: null, children: [] },
			{ tag: "user", attrs: {}, content: null, children: [] },
			{ tag: "assistant", attrs: {}, content: null, children: [] },
		],
	};
	return new RummyContext(hookRoot, {
		db,
		store,
		project: PROJECT,
		type: "ask",
		sequence,
		runId: RUN_ID,
		turnId: 1,
		noContext: false,
		contextSize,
		systemPrompt: "You are a test assistant.",
		loopPrompt: "test prompt",
	});
}

async function assembleMessages(tdb, store) {
	const hooks = new HookRegistry();
	Engine.register(hooks);
	const rummy = makeRummy(tdb.db, store);
	await hooks.processTurn(rummy);
	const rows = await tdb.db.get_turn_context.all({
		run_id: RUN_ID,
		turn: TURN,
	});
	return ContextAssembler.assembleFromTurnContext(rows, {
		type: "ask",
		tools: "unknown read env ask_user write move copy store delete update summary",
	});
}

describe("Message assembly", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db, new HookRegistry());
		const seed = await tdb.seedRun();
		RUN_ID = seed.runId;
		PROJECT = { id: seed.projectId, path: "/tmp/test" };
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("ask prompt renders as <ask> tag with tools", async () => {
		await store.upsert(RUN_ID, TURN, "ask://1", "What is the port?", "info");
		const messages = await assembleMessages(tdb, store);
		const user = messages.find((m) => m.role === "user");
		assert.ok(user.content.includes("<ask tools="), "should have <ask> tag");
		assert.ok(
			user.content.includes("What is the port?"),
			"should contain prompt text",
		);
		assert.ok(
			!user.content.includes("run "),
			"ask tools should not include run",
		);
	});

	it("act prompt renders as <act> tag with run tool", async () => {
		await store.upsert(RUN_ID, TURN, "act://1", "Refactor the code", "info");
		const hooks = new HookRegistry();
		Engine.register(hooks);
		const hookRoot = {
			tag: "turn",
			attrs: {},
			content: null,
			children: [
				{ tag: "system", attrs: {}, content: null, children: [] },
				{ tag: "context", attrs: {}, content: null, children: [] },
				{ tag: "user", attrs: {}, content: null, children: [] },
				{ tag: "assistant", attrs: {}, content: null, children: [] },
			],
		};
		const rummy = new RummyContext(hookRoot, {
			db: tdb.db,
			store,
			project: PROJECT,
			type: "act",
			sequence: TURN,
			runId: RUN_ID,
			turnId: 1,
			noContext: false,
			contextSize: 50000,
			systemPrompt: "You are a test assistant.",
			loopPrompt: "test",
		});
		await hooks.processTurn(rummy);
		const rows = await tdb.db.get_turn_context.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const messages = ContextAssembler.assembleFromTurnContext(rows, {
			type: "act",
			tools: "unknown read env ask_user write move copy store delete run update summary",
		});
		const user = messages.find((m) => m.role === "user");
		assert.ok(user.content.includes("<act tools="), "should have <act> tag");
		assert.ok(user.content.includes("run "), "act tools should include run");
	});

	it("pattern result appears in messages with matched paths", async () => {
		await store.upsert(RUN_ID, TURN, "src/app.js", "const x = 1;", "full");
		await store.upsert(RUN_ID, TURN, "src/utils.js", "const y = 2;", "full");
		await store.upsert(
			RUN_ID,
			TURN,
			"read://src_js",
			'read path="src/*.js": 2 matched (100 tokens)\nsrc/app.js (50)\nsrc/utils.js (50)',
			"pattern",
		);
		const messages = await assembleMessages(tdb, store);
		const user = messages.find((m) => m.role === "user");
		assert.ok(user.content.includes("2 matched"), "should show match count");
		assert.ok(user.content.includes("src/app.js"), "should list matched paths");
	});

	it("preview result shows PREVIEW prefix", async () => {
		await store.upsert(
			RUN_ID,
			TURN,
			"read://preview_test",
			'PREVIEW read path="src/*.js": 2 matched (100 tokens)\nsrc/app.js (50)\nsrc/utils.js (50)',
			"pattern",
		);
		const messages = await assembleMessages(tdb, store);
		const user = messages.find((m) => m.role === "user");
		assert.ok(user.content.includes("PREVIEW"), "should show PREVIEW prefix");
	});

	it("tool result content is visible (not blank)", async () => {
		await store.upsert(
			RUN_ID,
			TURN,
			"search://test_query",
			"10 results for test",
			"info",
		);
		await store.upsert(
			RUN_ID,
			TURN,
			"env://node_ver",
			"<env>node --version</env>",
			"pass",
		);
		await store.upsert(
			RUN_ID,
			TURN,
			"delete://rm_test",
			"rm src/old.js",
			"pass",
		);
		await store.upsert(
			RUN_ID,
			TURN,
			"move://mv_test",
			"mv known://a known://b",
			"pass",
		);
		await store.upsert(
			RUN_ID,
			TURN,
			"copy://cp_test",
			"cp known://x known://y",
			"pass",
		);

		const messages = await assembleMessages(tdb, store);
		const user = messages.find((m) => m.role === "user");

		assert.ok(
			user.content.includes("10 results for test"),
			"search content visible",
		);
		assert.ok(
			user.content.includes("<env>node --version</env>"),
			"env content visible",
		);
		assert.ok(user.content.includes("rm src/old.js"), "delete content visible");
		assert.ok(
			user.content.includes("mv known://a known://b"),
			"move content visible",
		);
		assert.ok(
			user.content.includes("cp known://x known://y"),
			"copy content visible",
		);
	});

	it("structural entries (summary/update) appear in messages", async () => {
		await store.upsert(
			RUN_ID,
			TURN,
			"summary://test_sum",
			"The answer is 42",
			"summary",
		);
		const messages = await assembleMessages(tdb, store);
		const user = messages.find((m) => m.role === "user");
		assert.ok(
			user.content.includes("The answer is 42"),
			"summary visible in messages",
		);
	});

	it("context contains files and knowledge, not results", async () => {
		const messages = await assembleMessages(tdb, store);
		const system = messages.find((m) => m.role === "system");
		assert.ok(
			system.content.includes("<context>"),
			"should have context section",
		);
		assert.ok(system.content.includes("src/app.js"), "files in context");
		// Results should NOT be in the system message
		assert.ok(
			!system.content.includes("10 results for test"),
			"search not in system",
		);
		assert.ok(
			!system.content.includes("rm src/old.js"),
			"delete not in system",
		);
	});
});
