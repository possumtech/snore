import assert from "node:assert/strict";
import { describe, it } from "node:test";
import RpcRegistry from "./RpcRegistry.js";

describe("RpcRegistry", () => {
	it("register/get/has expose registered methods", () => {
		const reg = new RpcRegistry();
		reg.register("ping", { handler: async () => "pong", description: "p" });
		assert.equal(reg.has("ping"), true);
		assert.equal(reg.get("ping").description, "p");
	});

	it("register applies defaults for description/params/requiresInit/longRunning", () => {
		const reg = new RpcRegistry();
		reg.register("m", { handler: async () => null });
		const def = reg.get("m");
		assert.equal(def.description, "");
		assert.deepEqual(def.params, {});
		assert.equal(def.requiresInit, false);
		assert.equal(def.longRunning, false);
	});

	it("registered defs are frozen (cannot mutate)", () => {
		const reg = new RpcRegistry();
		reg.register("m", { handler: async () => null });
		assert.throws(() => {
			reg.get("m").description = "mutated";
		});
	});

	it("registerNotification stores notification metadata in discover()", () => {
		const reg = new RpcRegistry();
		reg.registerNotification("ev/x", "an event");
		const out = reg.discover();
		assert.deepEqual(out.notifications, {
			"ev/x": { description: "an event" },
		});
	});

	it("discover lists registered methods by name with description+params", () => {
		const reg = new RpcRegistry();
		reg.register("ping", {
			handler: async () => null,
			description: "ping",
			params: { run: "string" },
		});
		const out = reg.discover();
		assert.deepEqual(out.methods.ping, {
			description: "ping",
			params: { run: "string" },
		});
	});

	describe("tool fallback", () => {
		function buildFallbackHooks(tools) {
			const list = new Set(tools);
			return {
				tools: {
					has: (n) => list.has(n),
					names: [...list],
				},
			};
		}

		it("get(name) returns fallback def when tool exists and method does not", () => {
			const reg = new RpcRegistry();
			reg.setToolFallback(
				buildFallbackHooks(["set"]),
				async () => ({ rummy: {} }),
				async () => {},
			);
			const def = reg.get("set");
			assert.ok(def);
			assert.equal(def.requiresInit, true);
			assert.match(def.description, /Dispatch set/);
		});

		it("get(name) returns undefined when tool is unknown and method missing", () => {
			const reg = new RpcRegistry();
			reg.setToolFallback(
				buildFallbackHooks([]),
				async () => ({ rummy: {} }),
				async () => {},
			);
			assert.equal(reg.get("nope"), undefined);
		});

		it("has(name) covers both registered and fallback dispatch", () => {
			const reg = new RpcRegistry();
			reg.register("ping", { handler: async () => null });
			reg.setToolFallback(
				buildFallbackHooks(["set"]),
				async () => ({ rummy: {} }),
				async () => {},
			);
			assert.equal(reg.has("ping"), true);
			assert.equal(reg.has("set"), true);
			assert.equal(reg.has("missing"), false);
		});

		it("fallback handler dispatches with required params", async () => {
			const dispatched = [];
			const reg = new RpcRegistry();
			reg.setToolFallback(
				buildFallbackHooks(["set"]),
				async (_hooks, _ctx, run) => ({ rummy: { run } }),
				async (_hooks, rummy, name, path, body, attrs) => {
					dispatched.push({ rummy, name, path, body, attrs });
				},
			);
			const def = reg.get("set");
			const result = await def.handler({ run: "r1", path: "x", body: "b" }, {});
			assert.deepEqual(result, { status: "ok" });
			assert.equal(dispatched[0].name, "set");
			assert.equal(dispatched[0].rummy.run, "r1");
			assert.equal(dispatched[0].path, "x");
			assert.equal(dispatched[0].body, "b");
		});

		it("fallback handler throws when path is missing", async () => {
			const reg = new RpcRegistry();
			reg.setToolFallback(
				buildFallbackHooks(["set"]),
				async () => ({ rummy: {} }),
				async () => {},
			);
			const def = reg.get("set");
			await assert.rejects(def.handler({ run: "r" }, {}), /path is required/);
		});

		it("fallback handler throws when run is missing", async () => {
			const reg = new RpcRegistry();
			reg.setToolFallback(
				buildFallbackHooks(["set"]),
				async () => ({ rummy: {} }),
				async () => {},
			);
			const def = reg.get("set");
			await assert.rejects(def.handler({ path: "x" }, {}), /run is required/);
		});

		it("discover includes auto-dispatched tools that have no explicit register", () => {
			const reg = new RpcRegistry();
			reg.register("ping", { handler: async () => null });
			reg.setToolFallback(
				buildFallbackHooks(["set", "get"]),
				async () => ({ rummy: {} }),
				async () => {},
			);
			const out = reg.discover();
			assert.ok(out.methods.ping);
			assert.ok(out.methods.set);
			assert.ok(out.methods.get);
		});

		it("discover does not double-list a tool that is also explicitly registered", () => {
			const reg = new RpcRegistry();
			reg.register("set", {
				handler: async () => null,
				description: "explicit",
			});
			reg.setToolFallback(
				buildFallbackHooks(["set"]),
				async () => ({ rummy: {} }),
				async () => {},
			);
			const out = reg.discover();
			assert.equal(out.methods.set.description, "explicit");
		});
	});
});
