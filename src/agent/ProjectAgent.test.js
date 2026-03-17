import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import createHooks from "../core/Hooks.js";
import { registerPlugins } from "../plugins/index.js";
import ProjectAgent from "./ProjectAgent.js";
import TestDb from "../../test/helpers/TestDb.js";

describe("ProjectAgent Unit", () => {
	const projectPath = join(process.cwd(), "test_agent_unit");
	let hooks;
	let tdb;
	let agent;

	before(async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
		process.env.RUMMY_MODEL_DEFAULT = "test-model";
		process.env.RUMMY_HTTP_REFERER = "http://test";
		process.env.RUMMY_X_TITLE = "Test";
		await fs.mkdir(projectPath, { recursive: true }).catch(() => {});
		hooks = createHooks();
		await registerPlugins([], hooks);
		tdb = await TestDb.create("project_agent");
		agent = new ProjectAgent(tdb.db, hooks);
	});

	after(async () => {
		await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
		if (tdb) await tdb.cleanup();
	});

	it("should initialize a project correctly", async () => {
		const result = await agent.init(projectPath, "Test", "client-1");
		assert.ok(result.projectId);
		assert.ok(result.sessionId);
	});

	it("should update file visibility", async () => {
		const initRes = await agent.init(projectPath, "Test", "client-1");
		const result = await agent.updateFiles(initRes.projectId, [
			{ path: "f.js", visibility: "active" },
		]);
		assert.strictEqual(result.status, "ok");
	});

	it("should get files", async () => {
		await agent.init(projectPath, "Test", "client-1");
		const files = await agent.getFiles(projectPath);
		assert.ok(Array.isArray(files));
	});

	it("should handle 'ask' method", async () => {
		const initRes = await agent.init(projectPath, "Test", "client-1");

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(
			JSON.stringify({
				model: "test-model",
				choices: [{ message: { role: "assistant", content: "Paris" } }],
				usage: { total_tokens: 10 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		);

		try {
			const result = await agent.ask(
				initRes.sessionId,
				process.env.RUMMY_MODEL_DEFAULT,
				"Capital?",
			);
			assert.strictEqual(result.content, "Paris");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
