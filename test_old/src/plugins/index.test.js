import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import createHooks from "../domain/hooks/Hooks.js";
import { registerPlugins } from "./index.js";

test("Plugin Registry", async (t) => {
	const pluginsDir = join(process.cwd(), "test_plugins");

	t.beforeEach(async () => {
		await fs.rm(pluginsDir, { recursive: true, force: true });
		await fs.mkdir(pluginsDir, { recursive: true });
	});

	t.after(async () => {
		await fs.rm(pluginsDir, { recursive: true, force: true });
	});

	await t.test(
		"registerPlugins should load plugins from directory",
		async () => {
			await fs.writeFile(
				join(pluginsDir, "mock_plugin.js"),
				"export default class Mock { static register(hooks) { hooks.mocked = true; } }",
			);
			const hooks = createHooks();
			hooks.mocked = false;
			await registerPlugins([pluginsDir], hooks);
			assert.ok(hooks.mocked, "Mock plugin should have been registered");
		},
	);

	await t.test("should skip non-existent directory", async () => {
		const hooks = createHooks();
		await registerPlugins(["/tmp/nonexistent_plugin_dir_xyz"], hooks);
		assert.ok(true, "No error thrown");
	});

	await t.test(
		"should load plugin from subdirectory by convention",
		async () => {
			const subDir = join(pluginsDir, "myplugin");
			await fs.mkdir(subDir, { recursive: true });
			await fs.writeFile(
				join(subDir, "myplugin.js"),
				"export default class P { static register(hooks) { hooks.subLoaded = true; } }",
			);
			const hooks = createHooks();
			hooks.subLoaded = false;
			await registerPlugins([pluginsDir], hooks);
			assert.ok(
				hooks.subLoaded,
				"Subdirectory plugin loaded by basename convention",
			);
		},
	);

	await t.test("should skip .test.js files", async () => {
		await fs.writeFile(
			join(pluginsDir, "bad.test.js"),
			"export default class Bad { static register() { throw new Error('should not load'); } }",
		);
		const hooks = createHooks();
		await registerPlugins([pluginsDir], hooks);
		assert.ok(true, "Test files skipped");
	});

	await t.test("should skip files without register method", async () => {
		await fs.writeFile(
			join(pluginsDir, "noregister.js"),
			"export default class NR {}",
		);
		const hooks = createHooks();
		await registerPlugins([pluginsDir], hooks);
		assert.ok(true, "No error for missing register");
	});
});
