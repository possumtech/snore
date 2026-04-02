import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AuditClient from "../helpers/AuditClient.js";
import TestDb from "../helpers/TestDb.js";
import TestServer from "../helpers/TestServer.js";

describe("E2E: Custom Plugin Registration", () => {
	let tdb, tserver, client;
	const projectPath = join(tmpdir(), `rummy-plugin-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });
		await fs.writeFile(join(projectPath, "app.js"), "const x = 1;\n");
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectPath },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb.db);

		// Register a custom RPC method via plugin contract
		tserver.hooks.rpc.registry.register("test/echo", {
			handler: async (params) => ({ echo: params }),
			description: "Echo params back for testing.",
		});

		// Register a custom RPC method that requires init
		tserver.hooks.rpc.registry.register("test/projectInfo", {
			handler: async (_params, ctx) => ({
				projectId: ctx.projectId,
				sessionId: ctx.sessionId,
			}),
			description: "Return session context for testing.",
			requiresInit: true,
		});

		client = new AuditClient(tserver.url, tdb.db);
		await client.connect();
		await client.call("init", {
			projectPath,
			projectName: "PluginTest",
			clientId: "c-plugin",
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("custom RPC method is callable", async () => {
		const result = await client.call("test/echo", { msg: "hello" });
		assert.deepStrictEqual(result.echo, { msg: "hello" });
	});

	it("custom RPC method appears in discover", async () => {
		const catalog = await client.call("discover");
		assert.ok(catalog.methods["test/echo"], "test/echo in catalog");
		assert.ok(
			catalog.methods["test/projectInfo"],
			"test/projectInfo in catalog",
		);
	});

	it("custom RPC method with requiresInit receives context", async () => {
		const result = await client.call("test/projectInfo");
		assert.ok(result.projectId, "has projectId");
		assert.ok(result.sessionId, "has sessionId");
	});
});
