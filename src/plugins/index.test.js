import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import createHooks from "../domain/hooks/Hooks.js";
import { registerPlugins } from "./index.js";

test("Plugin Registry", async (t) => {
	const pluginsDir = join(process.cwd(), "test_plugins");
	await fs.mkdir(pluginsDir, { recursive: true });

	const pluginPath = join(pluginsDir, "mock_plugin.js");
	await fs.writeFile(
		pluginPath,
		"export default class Mock { static register(hooks) { hooks.mocked = true; } }",
	);

	t.after(async () => {
		await fs.rm(pluginsDir, { recursive: true, force: true });
	});

	await t.test(
		"registerPlugins should load plugins from directory",
		async () => {
			const hooks = createHooks();
			// Initialize a property to check if register was called
			hooks.mocked = false;

			await registerPlugins([pluginsDir], hooks);

			assert.ok(hooks.mocked, "Mock plugin should have been registered");
		},
	);
});
