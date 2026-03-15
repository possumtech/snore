import assert from "node:assert";
import { before, describe, it, mock } from "node:test";
import ModelAgent from "./ModelAgent.js";

describe("ModelAgent", () => {
	before(() => {
		process.env.OPENROUTER_API_KEY = "test-key";
	});

	it("should return a list of models from the database and environment", async () => {
		process.env.SNORE_MODEL_TEST_ALIAS = "target-model";

		const mockModels = [
			{ id: "db-model", name: "DB Model", description: "A db model" },
		];
		const mockDb = {
			get_models: {
				all: mock.fn(async () => mockModels),
			},
		};

		const agent = new ModelAgent(mockDb);
		const models = await agent.getModels();

		assert.ok(models.some((m) => m.id === "db-model"));
		assert.ok(models.some((m) => m.id === "TEST_ALIAS"));

		const alias = models.find((m) => m.id === "TEST_ALIAS");
		assert.strictEqual(alias.target, "target-model");

		delete process.env.SNORE_MODEL_TEST_ALIAS;
	});

	it("should fetch models from OpenRouter", async () => {
		const mockData = { data: [{ id: "model-1" }] };

		const fetchMock = mock.method(globalThis, "fetch", async () => ({
			ok: true,
			json: async () => mockData,
		}));

		const agent = new ModelAgent({});
		const models = await agent.getOpenRouterModels();

		assert.deepStrictEqual(models, mockData.data);
		assert.strictEqual(fetchMock.mock.callCount(), 1);
	});

	it("should throw error if fetch fails", async () => {
		mock.method(globalThis, "fetch", async () => ({
			ok: false,
			status: 500,
		}));

		const agent = new ModelAgent({});
		await assert.rejects(
			agent.getOpenRouterModels(),
			/Failed to fetch OpenRouter models: 500/,
		);
	});
});
