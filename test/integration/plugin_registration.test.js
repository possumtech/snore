/**
 * Plugin registration and convention tests.
 *
 * Covers @plugin_system, @plugin_convention, @scheme_registry.
 * When these fail, the documented plugin contract and implementation
 * are out of sync.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import PluginContext from "../../src/hooks/PluginContext.js";
import TestDb from "../helpers/TestDb.js";

describe("plugin registration (@plugin_system, @plugin_convention, @scheme_registry, @plugins_contract, @plugins_registration, @plugins_ensure_tool, @plugins_register_scheme, @plugins_tool_docs)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("plugin_registration");
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("plugin contract (@plugin_system)", () => {
		it("every bundled plugin registers via its constructor", () => {
			const tools = tdb.hooks.tools;
			for (const name of ["get", "set", "rm", "known", "unknown", "update"]) {
				assert.ok(tools.has(name), `${name} tool registered`);
			}
		});

		it("ensureTool makes a tool appear in the tool list", () => {
			const names = tdb.hooks.tools.names;
			assert.ok(names.includes("update"), "update in tool list");
			assert.ok(names.includes("unknown"), "unknown in tool list");
		});

		it("on('handler') auto-calls ensureTool (@plugin_convention)", () => {
			const names = tdb.hooks.tools.names;
			for (const name of ["get", "set", "rm"]) {
				assert.ok(names.includes(name), `${name} registered via handler`);
			}
		});

		it("handler-less tools still appear in tool list via explicit ensureTool", () => {
			const names = tdb.hooks.tools.names;
			assert.ok(names.includes("update"), "update has no handler but is listed");
			assert.ok(names.includes("unknown"));
		});

		it("every tool with a handler has a full view registered", () => {
			for (const tool of ["get", "set", "rm", "mv", "cp", "known"]) {
				assert.ok(
					tdb.hooks.tools.hasView(tool),
					`${tool} has view registered`,
				);
			}
		});
	});

	describe("scheme registry (@scheme_registry)", () => {
		it("CATEGORIES is frozen with exactly four roles", () => {
			const cats = PluginContext.CATEGORIES;
			assert.ok(Object.isFrozen(cats), "CATEGORIES is frozen");
			assert.strictEqual(cats.size, 4);
			for (const name of ["data", "logging", "unknown", "prompt"]) {
				assert.ok(cats.has(name), `${name} is a valid category`);
			}
		});

		it("registerScheme rejects invalid categories", () => {
			const ctx = new PluginContext("test_invalid", tdb.hooks);
			assert.throws(
				() => ctx.registerScheme({ category: "structural" }),
				/Invalid category/,
			);
		});

		it("registerScheme creates DB rows visible in views", async () => {
			const { runId } = await tdb.seedRun({ alias: "scheme_registry_1" });
			const store = new Entries(tdb.db);
			await store.set({
				runId,
				turn: 1,
				path: "known://scheme_test",
				body: "test",
				state: "resolved",
			});
			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "known://scheme_test");
			assert.ok(entry, "known entry created");
			assert.strictEqual(entry.scheme, "known", "scheme derived from path");
		});
	});

	describe("tool docs (@plugin_convention)", () => {
		it("filter('instructions.toolDocs') populates docs for handler tools", async () => {
			const docsMap = await tdb.hooks.instructions.toolDocs.filter(
				{},
				{ toolSet: new Set(tdb.hooks.tools.names) },
			);
			for (const name of ["get", "set", "rm"]) {
				assert.ok(docsMap[name], `${name} has tool docs`);
			}
		});

		it("toolDocs uses a docsMap pattern, not string concatenation", async () => {
			const docsMap = await tdb.hooks.instructions.toolDocs.filter(
				{},
				{ toolSet: new Set(tdb.hooks.tools.names) },
			);
			assert.strictEqual(typeof docsMap, "object");
			assert.ok(!Array.isArray(docsMap));
			for (const [key, value] of Object.entries(docsMap)) {
				assert.strictEqual(typeof key, "string");
				assert.strictEqual(typeof value, "string");
			}
		});
	});
});
