import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import ToolRegistry from "./ToolRegistry.js";

describe("ToolRegistry", () => {
	it("register and get should store and retrieve tools", () => {
		const reg = new ToolRegistry();
		reg.register("read", {
			modes: new Set(["ask", "act"]),
			category: "ask",
		});
		const tool = reg.get("read");
		ok(tool);
		ok(tool.modes.has("ask"));
		ok(tool.modes.has("act"));
		strictEqual(tool.category, "ask");
	});

	it("register should throw on duplicate name", () => {
		const reg = new ToolRegistry();
		reg.register("read", { modes: new Set(["ask"]), category: "ask" });
		throws(
			() => reg.register("read", { modes: new Set(["act"]), category: "act" }),
			/already registered/,
		);
	});

	it("has should return true for registered tools", () => {
		const reg = new ToolRegistry();
		reg.register("edit", { modes: new Set(["act"]), category: "act" });
		strictEqual(reg.has("edit"), true);
		strictEqual(reg.has("nonexistent"), false);
	});

	it("actTools should return only tools with category 'act'", () => {
		const reg = new ToolRegistry();
		reg.register("read", { modes: new Set(["ask", "act"]), category: "ask" });
		reg.register("edit", { modes: new Set(["act"]), category: "act" });
		reg.register("run", { modes: new Set(["act"]), category: "act" });
		reg.register("summary", {
			modes: new Set(["ask", "act"]),
			category: "structural",
		});

		const act = reg.actTools;
		ok(act.has("edit"));
		ok(act.has("run"));
		ok(!act.has("read"));
		ok(!act.has("summary"));
	});

	it("names should return all registered tool names", () => {
		const reg = new ToolRegistry();
		reg.register("read", { modes: new Set(["ask"]), category: "ask" });
		reg.register("edit", { modes: new Set(["act"]), category: "act" });
		deepStrictEqual(reg.names.sort(), ["edit", "read"]);
	});

	it("registered definitions should be frozen", () => {
		const reg = new ToolRegistry();
		reg.register("read", { modes: new Set(["ask"]), category: "ask" });
		const tool = reg.get("read");
		throws(() => {
			tool.category = "act";
		}, /Cannot assign/);
	});
});
