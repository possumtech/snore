import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

const model = process.env.RUMMY_MODEL_DEFAULT;
const TIMEOUT = 120_000;

describe("E2E: Notification Isolation", () => {
	let tdb, tserver, clientA, clientB;
	const projectPath = join(tmpdir(), `rummy-isolation-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(
			join(projectPath, "app.js"),
			"function greet() { return 'hello'; }\n",
		);

		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "test@test.com" && git config user.name "Test" && git add . && git commit --no-verify -m "feat: init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);

		clientA = new RpcClient(tserver.url);
		clientB = new RpcClient(tserver.url);
		await clientA.connect();
		await clientB.connect();

		await clientA.call("init", {
			projectPath,
			projectName: "IsolationProject",
			clientId: "client-A",
		});
		await clientB.call("init", {
			projectPath,
			projectName: "IsolationProject",
			clientId: "client-B",
		});
	});

	after(async () => {
		clientA.close();
		clientB.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("client A notifications should not leak to client B", {
		timeout: TIMEOUT,
	}, async () => {
		const aTurns = [];
		const bTurns = [];

		clientA.on("run/step/completed", (params) => {
			aTurns.push(params);
		});
		clientB.on("run/step/completed", (params) => {
			bTurns.push(params);
		});

		// Client A sends a question
		const resultA = await clientA.call("ask", {
			model,
			prompt: "What is 2 + 2? Reply with just the number.",
			noContext: true,
		});

		assert.ok(
			["completed", "proposed"].includes(resultA.status),
			`Client A should complete, got ${resultA.status}`,
		);

		// Client A should have received turn notifications
		assert.ok(
			aTurns.length > 0,
			"Client A should receive run/step/completed notifications",
		);

		// Client B should NOT have received any notifications from Client A's run
		assert.strictEqual(
			bTurns.length,
			0,
			`Client B should not receive Client A's notifications. Got ${bTurns.length} notifications.`,
		);

		clientA.removeAllListeners("run/step/completed");
		clientB.removeAllListeners("run/step/completed");
	});

	it("client B notifications should not leak to client A", {
		timeout: TIMEOUT,
	}, async () => {
		const aTurns = [];
		const bTurns = [];

		clientA.on("run/step/completed", (params) => {
			aTurns.push(params);
		});
		clientB.on("run/step/completed", (params) => {
			bTurns.push(params);
		});

		// Client B sends a question
		const resultB = await clientB.call("ask", {
			model,
			prompt: "What is 3 + 3? Reply with just the number.",
			noContext: true,
		});

		assert.ok(
			["completed", "proposed"].includes(resultB.status),
			`Client B should complete, got ${resultB.status}`,
		);

		assert.ok(
			bTurns.length > 0,
			"Client B should receive run/step/completed notifications",
		);

		assert.strictEqual(
			aTurns.length,
			0,
			`Client A should not receive Client B's notifications. Got ${aTurns.length} notifications.`,
		);

		clientA.removeAllListeners("run/step/completed");
		clientB.removeAllListeners("run/step/completed");
	});
});
