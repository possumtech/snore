import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import Rpc from "./rpc.js";

function makeCore() {
	const hooks = createHooks();
	const methods = new Map();
	const notifications = new Map();
	hooks.rpc.registry = {
		register: (name, def) => methods.set(name, def),
		registerNotification: (name, desc) => notifications.set(name, desc),
		setToolFallback: () => {},
	};
	const core = new PluginContext("rpc", hooks);
	new Rpc(core);
	return { hooks, methods, notifications };
}

describe("Rpc plugin: registrations", () => {
	it("registers the protocol surface (ping, discover, rummy/hello)", () => {
		const { methods } = makeCore();
		for (const m of ["ping", "discover", "rummy/hello"]) {
			assert.ok(methods.has(m), `${m} should be registered`);
		}
	});

	it("registers primitive RPCs (set, get, rm, cp, mv, update)", () => {
		const { methods } = makeCore();
		for (const m of ["set", "get", "rm", "cp", "mv", "update"]) {
			assert.ok(methods.has(m), `${m} should be registered`);
			assert.equal(methods.get(m).requiresInit, true);
		}
	});

	it("registers model RPCs (getModels, addModel, removeModel)", () => {
		const { methods } = makeCore();
		for (const m of ["getModels", "addModel", "removeModel"]) {
			assert.ok(methods.has(m));
		}
	});

	it("registers file-constraint RPCs", () => {
		const { methods } = makeCore();
		for (const m of ["file/constraint", "file/drop", "getConstraints"]) {
			assert.ok(methods.has(m));
		}
	});

	it("registers query RPCs (getEntries, getRuns, getRun)", () => {
		const { methods } = makeCore();
		for (const m of ["getEntries", "getRuns", "getRun"]) {
			assert.ok(methods.has(m));
		}
	});

	it("registers notifications (run/changed, stream/cancelled, ui/render, ui/notify)", () => {
		const { notifications } = makeCore();
		for (const n of [
			"run/changed",
			"stream/cancelled",
			"ui/render",
			"ui/notify",
		]) {
			assert.ok(notifications.has(n), `${n} should be registered`);
		}
	});
});

describe("Rpc plugin: simple handlers", () => {
	it("ping returns {}", async () => {
		const { methods } = makeCore();
		const result = await methods.get("ping").handler({}, {});
		assert.deepEqual(result, {});
	});

	it("discover delegates to ctx.rpcRegistry.discover()", async () => {
		const { methods } = makeCore();
		const ctx = {
			rpcRegistry: {
				discover: () => ({ methods: { x: {} }, notifications: {} }),
			},
		};
		const result = await methods.get("discover").handler({}, ctx);
		assert.deepEqual(result, { methods: { x: {} }, notifications: {} });
	});

	it("getModels returns shape [{ alias, actual, context_length }]", async () => {
		const { methods } = makeCore();
		const ctx = {
			db: {
				get_models: {
					all: async () => [
						{ alias: "a", actual: "openai/x", context_length: 100 },
						{
							alias: "b",
							actual: "openai/y",
							context_length: 200,
							extra: "ignored",
						},
					],
				},
			},
		};
		const result = await methods.get("getModels").handler({}, ctx);
		assert.equal(result.length, 2);
		assert.deepEqual(Object.keys(result[0]).toSorted(), [
			"actual",
			"alias",
			"context_length",
		]);
	});

	it("addModel upserts and returns { id, alias }", async () => {
		const { methods } = makeCore();
		const ctx = {
			db: {
				upsert_model: {
					get: async ({ alias }) => ({ id: 7, alias }),
				},
			},
		};
		const result = await methods
			.get("addModel")
			.handler({ alias: "n", actual: "openai/n" }, ctx);
		assert.deepEqual(result, { id: 7, alias: "n" });
	});

	it("removeModel calls db.delete_model.run", async () => {
		const { methods } = makeCore();
		let removed;
		const ctx = {
			db: {
				delete_model: {
					run: async ({ alias }) => {
						removed = alias;
					},
				},
			},
		};
		const result = await methods
			.get("removeModel")
			.handler({ alias: "old" }, ctx);
		assert.deepEqual(result, { status: "ok" });
		assert.equal(removed, "old");
	});
});

describe("Rpc plugin: rummy/hello version negotiation", () => {
	it("rejects MAJOR mismatch with descriptive error", async () => {
		const { methods } = makeCore();
		const { RUMMY_PROTOCOL_VERSION } = await import("../../server/protocol.js");
		const serverMajor = RUMMY_PROTOCOL_VERSION.split(".")[0];
		const incompatibleMajor = String(Number(serverMajor) + 99);
		await assert.rejects(
			methods.get("rummy/hello").handler(
				{
					clientVersion: `${incompatibleMajor}.0.0`,
					name: "p",
					projectRoot: "/r",
				},
				{},
			),
			/protocol mismatch/,
		);
	});

	it("requires name", async () => {
		const { methods } = makeCore();
		await assert.rejects(
			methods.get("rummy/hello").handler({ projectRoot: "/r" }, {}),
			/name is required/,
		);
	});

	it("requires projectRoot", async () => {
		const { methods } = makeCore();
		await assert.rejects(
			methods.get("rummy/hello").handler({ name: "p" }, {}),
			/projectRoot is required/,
		);
	});

	it("returns server version + projectId on success", async () => {
		const { methods } = makeCore();
		let captured;
		const ctx = {
			projectAgent: {
				init: async (n, r, c) => {
					captured = { n, r, c };
					return { projectId: 42 };
				},
			},
			setContext: () => {},
		};
		const { RUMMY_PROTOCOL_VERSION } = await import("../../server/protocol.js");
		const result = await methods
			.get("rummy/hello")
			.handler({ name: "proj", projectRoot: "/path", configPath: "/cfg" }, ctx);
		assert.equal(result.rummyVersion, RUMMY_PROTOCOL_VERSION);
		assert.equal(result.projectId, 42);
		assert.equal(result.projectRoot, "/path");
		assert.deepEqual(captured, { n: "proj", r: "/path", c: "/cfg" });
	});
});

describe("Rpc plugin: file/constraint validation", () => {
	it("rejects when pattern is missing", async () => {
		const { methods } = makeCore();
		await assert.rejects(
			methods.get("file/constraint").handler({ visibility: "add" }, {}),
			/pattern is required/,
		);
	});

	it("rejects unknown visibility", async () => {
		const { methods } = makeCore();
		await assert.rejects(
			methods
				.get("file/constraint")
				.handler({ pattern: "x", visibility: "weird" }, {}),
			/visibility must be one of/,
		);
	});

	it("file/drop rejects when pattern missing", async () => {
		const { methods } = makeCore();
		await assert.rejects(
			methods.get("file/drop").handler({}, {}),
			/pattern is required/,
		);
	});
});
