import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ToolRegistry from "./ToolRegistry.js";

describe("ToolRegistry", () => {
	it("ensureTool registers a tool exactly once", () => {
		const reg = new ToolRegistry();
		reg.ensureTool("set");
		const first = reg.get("set");
		reg.ensureTool("set");
		assert.strictEqual(reg.get("set"), first);
		assert.equal(reg.has("set"), true);
		assert.equal(reg.has("nope"), false);
	});

	it("get returns undefined for unregistered scheme", () => {
		const reg = new ToolRegistry();
		assert.equal(reg.get("missing"), undefined);
	});

	it("dispatch invokes handlers in priority order; returns false short-circuits", async () => {
		const reg = new ToolRegistry();
		reg.ensureTool("set");
		const order = [];
		reg.onHandle(
			"set",
			async () => {
				order.push("a");
				return false;
			},
			10,
		);
		reg.onHandle(
			"set",
			async () => {
				order.push("b");
			},
			20,
		);
		await reg.dispatch("set", { path: "x" }, {});
		assert.deepEqual(order, ["a"]);
	});

	it("dispatch with no handlers is a no-op", async () => {
		const reg = new ToolRegistry();
		await reg.dispatch("absent", { path: "x" }, {});
	});

	it("dispatch passes both entry and rummy to handlers", async () => {
		const reg = new ToolRegistry();
		reg.ensureTool("set");
		let captured;
		reg.onHandle("set", async (entry, rummy) => {
			captured = { entry, rummy };
		});
		await reg.dispatch("set", { path: "x" }, { run: 1 });
		assert.deepEqual(captured.entry, { path: "x" });
		assert.deepEqual(captured.rummy, { run: 1 });
	});

	it("onView + view default to 'visible'", async () => {
		const reg = new ToolRegistry();
		reg.onView("set", async () => "body");
		const out = await reg.view("set", { path: "x" });
		assert.equal(out, "body");
	});

	it("view honors explicit visibility on the entry", async () => {
		const reg = new ToolRegistry();
		reg.onView("set", async () => "v", "visible");
		reg.onView("set", async () => "s", "summarized");
		assert.equal(await reg.view("set", { visibility: "summarized" }), "s");
	});

	it("view returns empty string when visibility has no view registered", async () => {
		const reg = new ToolRegistry();
		reg.onView("set", async () => "v", "visible");
		assert.equal(await reg.view("set", { visibility: "summarized" }), "");
	});

	it("view normalizes nullish view returns to empty string", async () => {
		const reg = new ToolRegistry();
		reg.onView("set", async () => null);
		assert.equal(await reg.view("set", {}), "");
	});

	it("view throws when scheme has no view registered at all", async () => {
		const reg = new ToolRegistry();
		await assert.rejects(reg.view("nope", {}), /No view registered for scheme/);
	});

	it("hasView reflects whether any visibility is registered", () => {
		const reg = new ToolRegistry();
		assert.equal(reg.hasView("set"), false);
		reg.onView("set", async () => "v");
		assert.equal(reg.hasView("set"), true);
	});

	it("names sorts using TOOL_ORDER and pins update last", () => {
		const reg = new ToolRegistry();
		for (const n of ["update", "set", "think", "get", "extra"])
			reg.ensureTool(n);
		const names = reg.names;
		assert.equal(names[0], "think");
		assert.equal(names.at(-1), "update");
		assert.ok(names.indexOf("get") < names.indexOf("set"));
	});

	it("names places out-of-list tools alphabetically after known ones", () => {
		const reg = new ToolRegistry();
		for (const n of ["set", "zeta", "alpha"]) reg.ensureTool(n);
		const names = reg.names;
		assert.equal(names[0], "set");
		assert.deepEqual(names.slice(1), ["alpha", "zeta"]);
	});

	it("advertisedNames excludes hidden tools", () => {
		const reg = new ToolRegistry();
		for (const n of ["think", "set", "secret"]) reg.ensureTool(n);
		reg.markHidden("secret");
		assert.deepEqual(reg.advertisedNames, ["think", "set"]);
	});

	it("resolveForLoop ask mode excludes 'sh'", () => {
		const reg = new ToolRegistry();
		for (const n of ["think", "set", "sh"]) reg.ensureTool(n);
		const names = reg.resolveForLoop("ask");
		assert.equal(names.has("sh"), false);
		assert.equal(names.has("think"), true);
	});

	it("resolveForLoop noInteraction excludes 'ask_user'", () => {
		const reg = new ToolRegistry();
		for (const n of ["think", "ask_user"]) reg.ensureTool(n);
		const names = reg.resolveForLoop("act", { noInteraction: true });
		assert.equal(names.has("ask_user"), false);
	});

	it("resolveForLoop noWeb excludes 'search'", () => {
		const reg = new ToolRegistry();
		for (const n of ["think", "search"]) reg.ensureTool(n);
		const names = reg.resolveForLoop("act", { noWeb: true });
		assert.equal(names.has("search"), false);
	});

	it("resolveForLoop noProposals excludes ask_user/env/sh", () => {
		const reg = new ToolRegistry();
		for (const n of ["think", "ask_user", "env", "sh"]) reg.ensureTool(n);
		const names = reg.resolveForLoop("act", { noProposals: true });
		assert.equal(names.has("ask_user"), false);
		assert.equal(names.has("env"), false);
		assert.equal(names.has("sh"), false);
		assert.equal(names.has("think"), true);
	});

	it("entries() yields all registered [name, def] pairs", () => {
		const reg = new ToolRegistry();
		reg.ensureTool("set");
		reg.ensureTool("think");
		const names = [...reg.entries()].map(([n]) => n).toSorted();
		assert.deepEqual(names, ["set", "think"]);
	});
});
