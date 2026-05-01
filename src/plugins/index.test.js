import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import createHooks from "../hooks/Hooks.js";
import { initPlugins, registerPlugins } from "./index.js";

describe("registerPlugins", () => {
	let tmp;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "rummy-plugins-"));
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("returns empty instances when no dirs given and no RUMMY_PLUGIN_* env", async () => {
		const hooks = createHooks();
		const instances = await registerPlugins([], hooks);
		assert.equal(instances.size, 0);
	});

	it("imports root-level .js files (excluding *.test.js)", async () => {
		const root = join(tmp, "root");
		await mkdir(root, { recursive: true });
		// helper module file (treated as plugin since it's at root)
		await writeFile(
			join(root, "alpha.js"),
			"export default class { constructor(c){ c.registerScheme(); } }",
		);
		await writeFile(join(root, "alpha.test.js"), "// must be skipped");

		const hooks = createHooks();
		const instances = await registerPlugins([root], hooks);
		assert.ok(instances.has("alpha"));
	});

	it("descends into subdirectories and imports {dir}.js or index.js as the entry", async () => {
		const root = join(tmp, "root");
		const sub = join(root, "myplugin");
		await mkdir(sub, { recursive: true });
		await writeFile(
			join(sub, "myplugin.js"),
			"export default class { constructor(c){ c.registerScheme({ name: 'myplugin' }); } }",
		);
		await writeFile(join(sub, "helper.js"), "export const x = 1;");

		const hooks = createHooks();
		const instances = await registerPlugins([root], hooks);
		assert.ok(instances.has("myplugin"));
		assert.equal(instances.has("helper"), false);
	});

	it("skips directories with a DISABLED sentinel", async () => {
		const root = join(tmp, "root");
		const sub = join(root, "off");
		await mkdir(sub, { recursive: true });
		await writeFile(join(sub, "DISABLED"), "");
		await writeFile(
			join(sub, "off.js"),
			"export default class { constructor(c){ c.registerScheme({ name: 'off' }); } }",
		);

		const hooks = createHooks();
		const instances = await registerPlugins([root], hooks);
		assert.equal(instances.has("off"), false);
	});

	it("env plugin failures log + continue (do not throw)", async () => {
		const original = process.env.RUMMY_PLUGIN_BOGUS;
		process.env.RUMMY_PLUGIN_BOGUS = "/nonexistent/package/name";
		const oWarn = console.warn;
		const oErr = console.error;
		const messages = [];
		console.warn = (...args) => messages.push(args.join(" "));
		console.error = (...args) => messages.push(args.join(" "));
		try {
			const hooks = createHooks();
			const instances = await registerPlugins([], hooks);
			assert.equal(instances.size, 0);
			assert.ok(messages.some((w) => /bogus/.test(w)));
		} finally {
			console.warn = oWarn;
			console.error = oErr;
			if (original === undefined) delete process.env.RUMMY_PLUGIN_BOGUS;
			else process.env.RUMMY_PLUGIN_BOGUS = original;
		}
	});

	it("invokes static Plugin.register(hooks) when provided", async () => {
		const root = join(tmp, "root");
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, "registry-style.js"),
			"export default { register(hooks){ hooks._registered = true; } };",
		);

		const hooks = createHooks();
		await registerPlugins([root], hooks);
		assert.equal(hooks._registered, true);
	});

	it("ignores modules whose default export is neither class nor object-with-register", async () => {
		const root = join(tmp, "root");
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "noop.js"), "export default 42;");

		const hooks = createHooks();
		const instances = await registerPlugins([root], hooks);
		assert.equal(instances.has("noop"), false);
	});
});

describe("initPlugins", () => {
	function makeDb() {
		const writes = [];
		return {
			upsert_scheme: {
				run: async (params) => writes.push(params),
			},
			_writes: writes,
		};
	}

	it("upserts the audit/prompt/log/lifecycle schemes regardless of plugin set", async () => {
		const db = makeDb();
		await initPlugins(db, createHooks(), new Map());
		const names = db._writes.map((w) => w.name);
		for (const expected of [
			"instructions",
			"system",
			"reasoning",
			"model",
			"user",
			"assistant",
			"content",
			"prompt",
			"log",
			"run",
		]) {
			assert.ok(names.includes(expected), `expected ${expected} upserted`);
		}
	});

	it("upserts plugin-declared schemes and tool fallback schemes", async () => {
		const db = makeDb();
		const hooks = createHooks();
		hooks.tools.ensureTool("set");
		hooks.tools.ensureTool("custom");
		const instances = new Map();
		instances.set("set", {
			schemes: [
				{
					name: "set",
					model_visible: 1,
					category: "logging",
					default_scope: "run",
					writable_by: '["model"]',
				},
			],
		});
		await initPlugins(db, hooks, instances);
		const names = db._writes.map((w) => w.name);
		assert.ok(names.includes("set"));
		// 'custom' was registered via ensureTool but not declared → fallback scheme.
		assert.ok(names.includes("custom"));
	});
});
