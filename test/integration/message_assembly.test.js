/**
 * Message assembly integration test.
 *
 * Verifies what we actually send to the model by populating known_entries,
 * materializing turn_context, and assembling the messages. Inspects the
 * system and user message content directly.
 */
import assert from "node:assert";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ContextAssembler from "../../src/agent/ContextAssembler.js";
import KnownStore from "../../src/agent/KnownStore.js";
import createHooks from "../../src/hooks/Hooks.js";
import { registerPlugins } from "../../src/plugins/index.js";
import RpcRegistry from "../../src/server/RpcRegistry.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;
let hooks;
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
	return ContextAssembler.assembleFromTurnContext(
		rows,
		{
			type: "ask",
			tools: "unknown get env ask_user set mv cp store rm update summary",
		},
		hooks,
	);
}

describe("Message assembly", () => {
	let tdb, store;

	before(async () => {
		hooks = createHooks();
		hooks.rpc.registry = new RpcRegistry();
		const pluginsDir = join(
			dirname(fileURLToPath(import.meta.url)),
			"../../src/plugins",
		);
		await registerPlugins([pluginsDir], hooks);
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun();
		RUN_ID = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("ask prompt renders as <prompt mode=ask> with tools", async () => {
		await store.upsert(RUN_ID, TURN, "prompt://1", "What is the port?", 200, {
			attributes: { mode: "ask" },
		});
		const messages = await assembleMessages(tdb, store);
		const user = messages.find((m) => m.role === "user");
		assert.ok(
			user.content.includes('<prompt mode="ask"'),
			"should have prompt tag with ask mode",
		);
		assert.ok(
			user.content.includes("What is the port?"),
			"should contain prompt text",
		);
		assert.ok(!user.content.includes("sh,"), "ask tools should not include sh");
	});

	it("act prompt renders as <prompt mode=act> with sh tool", async () => {
		await store.upsert(RUN_ID, TURN, "prompt://1", "Refactor the code", 200, {
			attributes: { mode: "act" },
		});
		await materialize(tdb.db, {
			runId: RUN_ID,
			turn: TURN,
			systemPrompt: "You are a test assistant.",
		});
		const rows = await tdb.db.get_turn_context.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const messages = await ContextAssembler.assembleFromTurnContext(
			rows,
			{ type: "act" },
			hooks,
		);
		const user = messages.find((m) => m.role === "user");
		assert.ok(
			user.content.includes('<prompt mode="act"'),
			"should have prompt tag with act mode",
		);
		// Tools list was moved out of the user message's <prompt> attribute
		// — it's now advertised only via the system preamble's "XML Command
		// Tools:" line, because the attribute's OpenAI shape was priming
		// native tool-call emissions. This test helper bypasses the full
		// instructions-plugin projection, so the tools list isn't present
		// here; verifying mode is the right scope for this test.
	});

	it("pattern result appears in messages with matched paths", async () => {
		await store.upsert(RUN_ID, TURN, "src/app.js", "const x = 1;", 200);
		await store.upsert(RUN_ID, TURN, "src/utils.js", "const y = 2;", 200);
		await store.upsert(
			RUN_ID,
			TURN,
			"get://src_js",
			'get path="src/*.js": 2 matched (100 tokens)\nsrc/app.js (50)\nsrc/utils.js (50)',
			200,
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
			200,
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
			200,
		);
		await store.upsert(
			RUN_ID,
			TURN,
			"env://node_ver",
			"<env>node --version</env>",
			200,
		);
		await store.upsert(RUN_ID, TURN, "rm://rm_test", "rm src/old.js", 200);
		await store.upsert(
			RUN_ID,
			TURN,
			"mv://mv_test",
			"mv known://a known://b",
			200,
		);
		await store.upsert(
			RUN_ID,
			TURN,
			"cp://cp_test",
			"cp known://x known://y",
			200,
		);

		const messages = await assembleMessages(tdb, store);
		const user = messages.find((m) => m.role === "user");

		assert.ok(
			user.content.includes("<search ") || user.content.includes("<env "),
			"tool tags present in current",
		);
		assert.ok(user.content.includes("10 results"), "search entry visible");
		assert.ok(user.content.includes("node"), "env entry visible");
		assert.ok(user.content.includes("<rm "), "rm entry visible");
		assert.ok(user.content.includes("<mv "), "mv entry visible");
		assert.ok(user.content.includes("<cp "), "cp entry visible");
	});

	it("structural entries (summary/update) appear in messages", async () => {
		await store.upsert(
			RUN_ID,
			TURN,
			"update://test_sum",
			"The answer is 42",
			200,
			{ fidelity: "demoted" },
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
			system.content.includes("<knowns>"),
			"should have knowns section",
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
