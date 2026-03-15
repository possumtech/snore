import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import ProjectAgent from "./ProjectAgent.js";

describe("ProjectAgent Unit", () => {
	const projectPath = join(process.cwd(), "test_agent_unit");

	before(async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		process.env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
		process.env.SNORE_DEFAULT_MODEL = "test-model";
		process.env.SNORE_HTTP_REFERER = "http://test";
		process.env.SNORE_X_TITLE = "Test";
		await fs.mkdir(projectPath, { recursive: true }).catch(() => {});
	});

	after(async () => {
		await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
	});

	it("should initialize a project correctly", async () => {
		const mockDb = {
			upsert_project: { run: mock.fn(async () => {}) },
			get_project_by_path: { all: mock.fn(async () => [{ id: "proj-1" }]) },
			create_session: { run: mock.fn(async () => {}) },
			get_repo_map_file: { get: mock.fn(async () => null) },
			upsert_repo_map_file: {
				run: mock.fn(async () => {}),
				get: mock.fn(async () => ({ id: "f1" })),
			},
			clear_repo_map_file_data: { run: mock.fn(async () => {}) },
			insert_repo_map_tag: { run: mock.fn(async () => {}) },
			insert_repo_map_ref: { run: mock.fn(async () => {}) },
			get_project_repo_map: { all: mock.fn(async () => []) },
		};

		const agent = new ProjectAgent(mockDb);
		const result = await agent.init(projectPath, "Test", "client-1");

		assert.strictEqual(result.projectId, "proj-1");
		assert.ok(result.sessionId);
	});

	it("should get files", async () => {
		const mockDb = {
			get_project_by_path: { all: mock.fn(async () => [{ id: "p1" }]) },
			get_project_repo_map: { all: mock.fn(async () => []) },
		};
		const agent = new ProjectAgent(mockDb);
		const files = await agent.getFiles(projectPath);
		assert.ok(Array.isArray(files));
	});

	it("should update file visibility", async () => {
		const mockDb = {
			upsert_repo_map_file: {
				run: mock.fn(),
				get: mock.fn(async () => ({ id: "f1" })),
			},
			get_project_by_id: {
				get: mock.fn(async () => ({ id: "p1", path: projectPath })),
			},
			get_project_repo_map: { all: mock.fn(async () => []) },
			get_repo_map_file: { get: mock.fn(async () => null) },
			clear_repo_map_file_data: { run: mock.fn() },
			insert_repo_map_tag: { run: mock.fn() },
			insert_repo_map_ref: { run: mock.fn() },
		};
		const agent = new ProjectAgent(mockDb);
		const result = await agent.updateFiles("p1", [
			{ path: "f.js", visibility: "active" },
		]);
		assert.strictEqual(result.status, "ok");
		assert.strictEqual(mockDb.upsert_repo_map_file.run.mock.callCount(), 1);
	});

	it("should handle 'ask' method", async () => {
		const mockDb = {
			get_session_by_id: { all: mock.fn(async () => [{ project_id: "p1" }]) },
			get_project_by_id: {
				get: mock.fn(async () => ({ id: "p1", path: projectPath })),
			},
			create_job: { run: mock.fn() },
			get_project_repo_map: { all: mock.fn(async () => []) },
			get_repo_map_file: { get: mock.fn(async () => null) },
			upsert_repo_map_file: {
				run: mock.fn(),
				get: mock.fn(async () => ({ id: "f1" })),
			},
			clear_repo_map_file_data: { run: mock.fn() },
			insert_repo_map_tag: { run: mock.fn() },
			insert_repo_map_ref: { run: mock.fn() },
			get_file_references: { all: mock.fn(async () => []) },
			create_turn: { run: mock.fn() },
			update_job_status: { run: mock.fn() },
		};

		mock.method(globalThis, "fetch", async () => ({
			ok: true,
			json: async () => ({
				choices: [{ message: { content: "Paris" } }],
				usage: { total_tokens: 10 },
			}),
		}));

		const agent = new ProjectAgent(mockDb);
		const result = await agent.ask(
			"sess-1",
			process.env.SNORE_DEFAULT_MODEL,
			"Capital?",
		);
		assert.strictEqual(result.response, "Paris");
	});
});
