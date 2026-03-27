import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import RpcRegistry from "./RpcRegistry.js";

describe("RpcRegistry", () => {
	it("register and get should store and retrieve methods", () => {
		const reg = new RpcRegistry();
		const handler = async () => ({});
		reg.register("ping", { handler, description: "Liveness check" });
		const method = reg.get("ping");
		ok(method);
		strictEqual(method.handler, handler);
		strictEqual(method.description, "Liveness check");
		strictEqual(method.requiresInit, false);
	});

	it("register should throw on duplicate name", () => {
		const reg = new RpcRegistry();
		reg.register("ping", { handler: async () => ({}) });
		throws(
			() => reg.register("ping", { handler: async () => ({}) }),
			/already registered/,
		);
	});

	it("has should return true for registered methods", () => {
		const reg = new RpcRegistry();
		reg.register("ping", { handler: async () => ({}) });
		strictEqual(reg.has("ping"), true);
		strictEqual(reg.has("nonexistent"), false);
	});

	it("requiresInit should default to false", () => {
		const reg = new RpcRegistry();
		reg.register("ping", { handler: async () => ({}) });
		strictEqual(reg.get("ping").requiresInit, false);
	});

	it("requiresInit can be set to true", () => {
		const reg = new RpcRegistry();
		reg.register("getFiles", {
			handler: async () => [],
			requiresInit: true,
		});
		strictEqual(reg.get("getFiles").requiresInit, true);
	});

	it("registerNotification should store notification metadata", () => {
		const reg = new RpcRegistry();
		reg.registerNotification("run/step/completed", "A turn finished.");
		const disc = reg.discover();
		ok(disc.notifications["run/step/completed"]);
		strictEqual(
			disc.notifications["run/step/completed"].description,
			"A turn finished.",
		);
	});

	it("discover should return all registered methods and notifications", () => {
		const reg = new RpcRegistry();
		reg.register("ping", {
			handler: async () => ({}),
			description: "Liveness",
		});
		reg.register("init", {
			handler: async () => ({}),
			description: "Initialize",
			params: { projectPath: "string" },
			requiresInit: false,
		});
		reg.registerNotification("ui/render", "Streaming output.");

		const disc = reg.discover();

		ok(disc.methods.ping);
		strictEqual(disc.methods.ping.description, "Liveness");

		ok(disc.methods.init);
		deepStrictEqual(disc.methods.init.params, { projectPath: "string" });

		ok(disc.notifications["ui/render"]);
	});

	it("registered methods should be frozen", () => {
		const reg = new RpcRegistry();
		reg.register("ping", { handler: async () => ({}) });
		const method = reg.get("ping");
		throws(() => {
			method.description = "hacked";
		}, /Cannot assign/);
	});
});
