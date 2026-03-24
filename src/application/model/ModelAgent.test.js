import assert from "node:assert";
import test from "node:test";
import createHooks from "../../domain/hooks/Hooks.js";
import ModelAgent from "./ModelAgent.js";

test("ModelAgent", async (t) => {
	const mockDb = {};
	const hooks = createHooks();
	const agent = new ModelAgent(mockDb, hooks);

	await t.test("getModels should return env aliases with consistent naming", async () => {
		process.env.RUMMY_MODEL_test = "openai/gpt-4";
		const models = await agent.getModels();
		const testModel = models.find((m) => m.alias === "test");
		assert.ok(testModel, "Should find the test alias");
		assert.strictEqual(testModel.actual, "openai/gpt-4");
		assert.strictEqual(testModel.display, "test");
		assert.strictEqual(testModel.target, "openai/gpt-4");
		delete process.env.RUMMY_MODEL_test;
	});

	await t.test("getModels should exclude RUMMY_MODEL_DEFAULT", async () => {
		const models = await agent.getModels();
		assert.ok(
			!models.some((m) => m.alias === "DEFAULT"),
			"Should not include DEFAULT as a model alias",
		);
	});
});
