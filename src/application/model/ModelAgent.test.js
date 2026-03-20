import assert from "node:assert";
import test from "node:test";
import createHooks from "../../domain/hooks/Hooks.js";
import ModelAgent from "./ModelAgent.js";

test("ModelAgent", async (t) => {
	const mockDb = {
		get_models: { all: async () => [{ id: "db-model", name: "DB Model" }] },
	};
	const hooks = createHooks();
	const agent = new ModelAgent(mockDb, hooks);

	await t.test("getModels should return merged db and env models", async () => {
		process.env.RUMMY_MODEL_test = "openai/gpt-4";
		const models = await agent.getModels();
		assert.ok(models.some((m) => m.id === "db-model"));
		assert.ok(models.some((m) => m.id === "test"));
		delete process.env.RUMMY_MODEL_test;
	});

	await t.test("getOpenRouterModels should fetch and filter", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					data: [{ id: "or-1", name: "OR Model" }],
				}),
			);
		const models = await agent.getOpenRouterModels();
		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].id, "or-1");
	});
});
