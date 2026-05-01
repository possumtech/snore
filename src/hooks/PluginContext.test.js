import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "./Hooks.js";
import PluginContext from "./PluginContext.js";

function ctx(name = "myplugin") {
	const hooks = createHooks();
	return { hooks, ctx: new PluginContext(name, hooks) };
}

describe("PluginContext", () => {
	it("name and hooks are exposed via getters", () => {
		const { hooks, ctx: c } = ctx("foo");
		assert.equal(c.name, "foo");
		assert.strictEqual(c.hooks, hooks);
	});

	it("registerScheme appends a scheme entry with defaults", () => {
		const { ctx: c } = ctx("scheme1");
		c.registerScheme();
		assert.equal(c.schemes.length, 1);
		const s = c.schemes[0];
		assert.equal(s.name, "scheme1");
		assert.equal(s.model_visible, 1);
		assert.equal(s.category, "logging");
		assert.equal(s.default_scope, "run");
		// writable_by is JSON-serialized.
		assert.deepEqual(JSON.parse(s.writable_by), ["model", "plugin"]);
	});

	it("registerScheme honors explicit name override", () => {
		const { ctx: c } = ctx("plugin");
		c.registerScheme({ name: "alt" });
		assert.equal(c.schemes[0].name, "alt");
	});

	it("registerScheme rejects invalid category", () => {
		const { ctx: c } = ctx("p");
		assert.throws(
			() => c.registerScheme({ category: "bogus" }),
			/Invalid category/,
		);
	});

	it("registerScheme rejects invalid scope", () => {
		const { ctx: c } = ctx("p");
		assert.throws(() => c.registerScheme({ scope: "bogus" }), /Invalid scope/);
	});

	it("registerScheme rejects invalid writer in writableBy", () => {
		const { ctx: c } = ctx("p");
		assert.throws(
			() => c.registerScheme({ writableBy: ["alien"] }),
			/Invalid writer/,
		);
	});

	it("ensureTool registers the plugin's name with the ToolRegistry", () => {
		const { hooks, ctx: c } = ctx("mytool");
		c.ensureTool();
		assert.ok(hooks.tools.has("mytool"));
	});

	it("markHidden tags the plugin's tool as hidden", () => {
		const { hooks, ctx: c } = ctx("mytool");
		c.ensureTool();
		c.markHidden();
		assert.deepEqual(hooks.tools.advertisedNames, []);
	});

	it("on('handler', cb) registers a tool handler", async () => {
		const { hooks, ctx: c } = ctx("dispatcher");
		let invoked = 0;
		c.on("handler", () => {
			invoked += 1;
		});
		await hooks.tools.dispatch("dispatcher", { path: "x" }, {});
		assert.equal(invoked, 1);
	});

	it("on('visible', cb) registers a visibility view", async () => {
		const { hooks, ctx: c } = ctx("v");
		c.on("visible", () => "rendered");
		c.ensureTool();
		const out = await hooks.tools.view("v", { path: "x" });
		assert.equal(out, "rendered");
	});

	it("on('event-name', cb) routes to the matching event hook", async () => {
		const { hooks, ctx: c } = ctx("p");
		let ran = 0;
		c.on("boot.completed", () => {
			ran += 1;
		});
		await hooks.boot.completed.emit();
		assert.equal(ran, 1);
	});

	it("on with unknown event name is a silent no-op", () => {
		const { ctx: c } = ctx("p");
		c.on("not.a.real.path", () => {});
		// should not throw
	});

	it("filter registers via the filter hook tree", async () => {
		const { hooks, ctx: c } = ctx("p");
		c.filter("assembly.user", async (v) => `${v}-x`);
		const out = await hooks.assembly.user.filter("seed");
		assert.equal(out, "seed-x");
	});

	it("filter with unknown filter name is a silent no-op", () => {
		const { ctx: c } = ctx("p");
		c.filter("not.a.real.filter", async (v) => v);
		// should not throw
	});
});
