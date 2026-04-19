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
	const projectRoot = join(tmpdir(), `rummy-plugin-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectRoot, { recursive: true });
		await fs.writeFile(join(projectRoot, "app.js"), "const x = 1;\n");
		const { execSync } = await import("node:child_process");
		execSync(
			'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
			{ cwd: projectRoot },
		);

		tdb = await TestDb.create();
		tserver = await TestServer.start(tdb);

		tserver.hooks.rpc.registry.register("test/echo", {
			handler: async (params) => ({ echo: params }),
			description: "Echo params back for testing.",
		});

		tserver.hooks.rpc.registry.register("test/projectInfo", {
			handler: async (_params, ctx) => ({
				projectId: ctx.projectId,
			}),
			description: "Return project context for testing.",
			requiresInit: true,
		});

		client = new AuditClient(tserver.url, tdb.db);
		await client.connect();
		await client.call("rummy/hello", {
			name: "PluginTest",
			projectRoot,
		});
	});

	after(async () => {
		client.close();
		await tserver.stop();
		await tdb.cleanup();
		await fs.rm(projectRoot, { recursive: true, force: true });
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
	});
});
