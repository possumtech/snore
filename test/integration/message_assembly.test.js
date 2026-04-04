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
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;
const TURN = 1;

async function assembleMessages(tdb, _store) {
	await materialize(tdb.db, {
		runId: RUN_ID,
		turn: TURN,
		systemPrompt: "You are a test assistant.",
	});
	const rows = await tdb.db.get_turn_context.all({
		run_id: RUN_ID,
		turn: TURN,
	});
	return ContextAssembler.assembleFromTurnContext(rows, {
		type: "ask",
		tools: "unknown get env ask_user set mv cp store rm update summary",
	});
}

describe("Message assembly", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun();
		RUN_ID = seed.runId;
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
		assert.ok(!user.content.includes("sh "), "ask tools should not include sh");
	});

	it("act prompt renders as <act> tag with run tool", async () => {
		await store.upsert(RUN_ID, TURN, "act://1", "Refactor the code", "info");
		await materialize(tdb.db, {
			runId: RUN_ID,
			turn: TURN,
			systemPrompt: "You are a test assistant.",
		});
		const rows = await tdb.db.get_turn_context.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const messages = ContextAssembler.assembleFromTurnContext(rows, {
			type: "act",
			tools: "unknown get env ask_user set mv cp store rm sh update summary",
		});
		const user = messages.find((m) => m.role === "user");
		assert.ok(user.content.includes("<act tools="), "should have <act> tag");
		assert.ok(user.content.includes("sh "), "act tools should include sh");
	});

	it("pattern result appears in messages with matched paths", async () => {
		await store.upsert(RUN_ID, TURN, "src/app.js", "const x = 1;", "full");
		await store.upsert(RUN_ID, TURN, "src/utils.js", "const y = 2;", "full");
		await store.upsert(
			RUN_ID,
			TURN,
			"get://src_js",
			'get path="src/*.js": 2 matched (100 tokens)\nsrc/app.js (50)\nsrc/utils.js (50)',
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
			"get://preview_test",
			'PREVIEW get path="src/*.js": 2 matched (100 tokens)\nsrc/app.js (50)\nsrc/utils.js (50)',
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
		await store.upsert(RUN_ID, TURN, "rm://rm_test", "rm src/old.js", "pass");
		await store.upsert(
			RUN_ID,
			TURN,
			"mv://mv_test",
			"mv known://a known://b",
			"pass",
		);
		await store.upsert(
			RUN_ID,
			TURN,
			"cp://cp_test",
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
			"summarize://test_sum",
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

	it("knowledge contains files and known entries, not results", async () => {
		const messages = await assembleMessages(tdb, store);
		const system = messages.find((m) => m.role === "system");
		assert.ok(
			system.content.includes("<knowledge>"),
			"should have knowledge section",
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
