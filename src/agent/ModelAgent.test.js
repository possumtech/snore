import assert from "node:assert";
import { before, describe, it, mock } from "node:test";
import createHooks from "../core/Hooks.js";
import ModelAgent from "./ModelAgent.js";

describe("ModelAgent", () => {
	let hooks;

	before(() => {
		hooks = createHooks();
	});

	it("should return a list of models from the database and environment", async () => {
		const mockDb = {
			get_models: {
				all: mock.fn(async () => [{ id: "db-model", name: "DB" }]),
			},
		};
		process.env.RUMMY_MODEL_alias = "target-model";

		const agent = new ModelAgent(mockDb, hooks);
		const models = await agent.getModels();

		assert.ok(models.length >= 2);
		assert.ok(models.some((m) => m.id === "db-model"));
		assert.strictEqual(
			models.find((m) => m.id === "alias").target,
			"target-model",
		);
	});

	it("should fetch models from OpenRouter", async () => {
		const mockDb = {};
		mock.method(globalThis, "fetch", async () => ({
			ok: true,
			json: async () => ({ data: [{ id: "m1" }] }),
		}));

		const agent = new ModelAgent(mockDb, hooks);
		const models = await agent.getOpenRouterModels();
		assert.strictEqual(models[0].id, "m1");
	});

	it("should throw error if fetch fails", async () => {
		mock.method(globalThis, "fetch", async () => ({ ok: false, status: 500 }));
		const agent = new ModelAgent({}, hooks);
		await assert.rejects(agent.getOpenRouterModels());
	});
});
