import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RpcClient from "../helpers/RpcClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E: RPC Surface", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-rpc-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "index.js"), "export default 42;\n");

		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "test@test.com" && git config user.name "Test" && git add . && git commit --no-verify -m "feat: init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);
		client = new RpcClient(tserver.url);
		await client.connect();
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("ping should return empty object without init", async () => {
		const result = await client.call("ping");
		assert.deepStrictEqual(result, {});
	});

	it("discover should return methods and notifications without init", async () => {
		const result = await client.call("discover");
		assert.ok(result.methods, "Should have methods");
		assert.ok(result.notifications, "Should have notifications");

		// Verify canonical methods exist
		const expectedMethods = [
			"ping",
			"init",
			"getModels",
			"getFiles",
			"fileStatus",
			"activate",
			"readOnly",
			"ignore",
			"drop",
			"startRun",
			"ask",
			"act",
			"run/resolve",
			"run/abort",
			"systemPrompt",
			"persona",
			"skill/add",
			"skill/remove",
		];
		for (const method of expectedMethods) {
			assert.ok(result.methods[method], `Missing method: ${method}`);
		}

		// Verify canonical notifications exist
		const expectedNotifications = [
			"run/step/completed",
			"run/progress",
			"ui/render",
			"ui/notify",
			"ui/prompt",
			"editor/diff",
			"run/env",
			"run/run",
		];
		for (const notif of expectedNotifications) {
			assert.ok(result.notifications[notif], `Missing notification: ${notif}`);
		}
	});

	it("rpc/discover should also work", async () => {
		const result = await client.call("rpc/discover");
		assert.ok(result.methods);
	});

	it("methods requiring init should error before init", async () => {
		const guarded = [
			"getFiles",
			"fileStatus",
			"activate",
			"readOnly",
			"ignore",
			"drop",
		];
		for (const method of guarded) {
			await assert.rejects(
				() => client.call(method, { path: "x", pattern: "x" }),
				(err) => {
					assert.ok(
						err.message.includes("not initialized"),
						`${method}: ${err.message}`,
					);
					return true;
				},
			);
		}
	});

	it("ask/act should error before init", async () => {
		await assert.rejects(
			() => client.call("ask", { prompt: "hi" }),
			(err) => {
				assert.ok(err.message.includes("not initialized"));
				return true;
			},
		);
		await assert.rejects(
			() => client.call("act", { prompt: "hi" }),
			(err) => {
				assert.ok(err.message.includes("not initialized"));
				return true;
			},
		);
	});

	it("unknown method should return JSON-RPC error", async () => {
		await assert.rejects(
			() => client.call("nonexistent_method"),
			(err) => {
				assert.ok(err.message.includes("not found"));
				return true;
			},
		);
	});

	it("init should return projectId, sessionId, and context", async () => {
		const result = await client.call("init", {
			projectPath,
			projectName: "RpcProject",
			clientId: "c-rpc",
		});

		assert.ok(result.projectId, "Should have projectId");
		assert.ok(result.sessionId, "Should have sessionId");
		assert.ok(result.context, "Should have context");
		assert.ok(result.context.gitRoot, "Should detect git root");
		assert.ok(result.context.headHash, "Should have head hash");
	});

	it("file promotion RPCs should work after init", async () => {
		// activate
		const activateResult = await client.call("activate", {
			pattern: "index.js",
		});
		assert.strictEqual(activateResult.status, "ok");

		const activeStatus = await client.call("fileStatus", { path: "index.js" });
		assert.strictEqual(activeStatus.fidelity, "full");
		assert.strictEqual(activeStatus.client_constraint, "full");

		// readOnly
		await client.call("readOnly", { pattern: "index.js" });
		const roStatus = await client.call("fileStatus", { path: "index.js" });
		assert.strictEqual(roStatus.fidelity, "full:readonly");

		// ignore
		await client.call("ignore", { pattern: "index.js" });
		const ignStatus = await client.call("fileStatus", { path: "index.js" });
		assert.strictEqual(ignStatus.fidelity, "excluded");

		// drop reverts to baseline
		await client.call("drop", { pattern: "index.js" });
		const dropStatus = await client.call("fileStatus", { path: "index.js" });
		assert.ok(
			["symbols", "path"].includes(dropStatus.fidelity),
			`Expected baseline fidelity, got ${dropStatus.fidelity}`,
		);
		assert.strictEqual(dropStatus.client_constraint, null);
	});

	it("getFiles should return project file list after init", async () => {
		const files = await client.call("getFiles");
		assert.ok(Array.isArray(files), "Should return an array");
		const indexFile = files.find((f) => f.path === "index.js");
		assert.ok(indexFile, "Should include index.js");
		assert.ok(indexFile.fidelity, "File should have fidelity");
	});

	it("session config RPCs should work after init", async () => {
		const spResult = await client.call("systemPrompt", {
			text: "You are a test agent.",
		});
		assert.strictEqual(spResult.status, "ok");

		const pResult = await client.call("persona", { text: "Friendly tester" });
		assert.strictEqual(pResult.status, "ok");

		const addResult = await client.call("skill/add", { name: "test-skill" });
		assert.strictEqual(addResult.status, "ok");

		const removeResult = await client.call("skill/remove", {
			name: "test-skill",
		});
		assert.strictEqual(removeResult.status, "ok");
	});
});
