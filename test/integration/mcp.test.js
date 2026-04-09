import assert from "node:assert";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import KnownStore from "../../src/agent/KnownStore.js";
import createHooks from "../../src/hooks/Hooks.js";
import RummyContext from "../../src/hooks/RummyContext.js";
import { initPlugins, registerPlugins } from "../../src/plugins/index.js";
import RpcRegistry from "../../src/server/RpcRegistry.js";
import TestDb from "../helpers/TestDb.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER_PATH = join(__dirname, "../helpers/McpMockServer.js");
const TEST_HOME = join(__dirname, "../../test/tmp/rummy_mcp_test");

process.env.RUMMY_HOME = TEST_HOME;

let RUN_ID;
let PROJECT;

function makeRummy(hooks, db, store, { sequence = 1 } = {}) {
	return new RummyContext(
		{
			tag: "turn",
			attrs: {},
			content: null,
			children: [],
		},
		{
			hooks,
			db,
			store,
			project: PROJECT,
			type: "act",
			sequence,
			runId: RUN_ID,
			turnId: 1,
			noRepo: false,
			contextSize: 50000,
			systemPrompt: "test",
			loopPrompt: "",
		},
	);
}

describe("MCP Plugin", () => {
	let tdb, store, hooks;

	before(async () => {
		try {
			tdb = await TestDb.create();
			store = new KnownStore(tdb.db);
			const seed = await tdb.seedRun({ alias: "mcp_test" });
			RUN_ID = seed.runId;
			PROJECT = { id: seed.projectId, path: "/tmp/test", name: "Test" };

			hooks = createHooks();
			hooks.rpc.registry = new RpcRegistry(hooks);

			const pluginsDir = join(__dirname, "../../src/plugins");
			await registerPlugins([pluginsDir], hooks);
			await initPlugins(tdb.db, store, hooks);
		} catch (err) {
			console.error("SETUP ERROR:", err);
			throw err;
		}
	});

	after(async () => {
		if (tdb) await tdb.cleanup();
		try {
			rmSync(TEST_HOME, { recursive: true, force: true });
		} catch (_err) {}
	});

	it("proposes installation (202) when 'get' is provided", async () => {
		try {
			const rummy = makeRummy(hooks, tdb.db, store);
			const resultPath = "mcp://test-server";
			const entry = {
				scheme: "mcp",
				path: "mcp://install",
				body: "",
				attributes: { name: "test-server", get: MOCK_SERVER_PATH },
				status: 200,
				resultPath,
			};

			await hooks.tools.dispatch("mcp", entry, rummy);

			const state = await store.getState(RUN_ID, resultPath);
			assert.strictEqual(state.status, 202, "installation is proposed");

			const body = await store.getBody(RUN_ID, resultPath);
			assert.ok(
				body.includes("Proposing installation"),
				"body has proposal text",
			);
		} catch (err) {
			console.error("TEST ERROR (proposes):", err);
			throw err;
		}
	});

	it("registers tools after resolution (202 -> 200)", async () => {
		try {
			const resultPath = "mcp://test-server";
			const rummy1 = makeRummy(hooks, tdb.db, store, { sequence: 1 });
			// 1. Propose
			await hooks.tools.dispatch(
				"mcp",
				{
					scheme: "mcp",
					path: "mcp://install",
					body: "",
					attributes: { name: "test-server", get: MOCK_SERVER_PATH },
					status: 200,
					resultPath,
				},
				rummy1,
			);

			// 2. Resolve
			await store.resolve(RUN_ID, resultPath, 200, "Approved");

			// 3. Trigger turn.started
			const rummy2 = makeRummy(hooks, tdb.db, store, { sequence: 2 });
			await hooks.turn.started.emit({ rummy: rummy2 });

			// Wait for async tool registration (spawn + tools/list)
			for (let i = 0; i < 20; i++) {
				if (hooks.tools.has("test_server_echo")) break;
				await new Promise((r) => setTimeout(r, 100));
			}

			// 4. Verify tool availability
			assert.ok(hooks.tools.has("test_server_echo"), "dynamic tool registered");
		} catch (err) {
			console.error("TEST ERROR (registers):", err);
			throw err;
		}
	});

	it("executes MCP tools", async () => {
		try {
			const rummy = makeRummy(hooks, tdb.db, store, { sequence: 3 });
			const resultPath = "test_server_echo://1";
			const entry = {
				scheme: "test_server_echo",
				path: resultPath,
				body: "",
				attributes: { message: "hello rummy" },
				status: 200,
				resultPath,
			};

			await hooks.tools.dispatch("test_server_echo", entry, rummy);

			const body = await store.getBody(RUN_ID, resultPath);
			assert.ok(
				body.includes("Echo: hello rummy"),
				"MCP tool executed and returned result",
			);
		} catch (err) {
			console.error("TEST ERROR (executes):", err);
			throw err;
		}
	});
});
