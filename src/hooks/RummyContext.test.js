import assert from "node:assert/strict";
import { describe, it } from "node:test";
import RummyContext from "./RummyContext.js";

function makeRoot(overrides = {}) {
	return {
		tag: "turn",
		attrs: {},
		content: null,
		children: [
			{ tag: "system", attrs: {}, content: null, children: [] },
			{ tag: "context", attrs: {}, content: null, children: [] },
			{ tag: "user", attrs: {}, content: null, children: [] },
			{ tag: "assistant", attrs: {}, content: null, children: [] },
			...(overrides.extraChildren || []),
		],
	};
}

describe("RummyContext", () => {
	describe("property accessors", () => {
		it("returns context values when present", () => {
			const ctx = {
				hooks: { budget: null },
				db: { prepared: true },
				store: { mark: "store" },
				project: { id: 1, name: "p" },
				activeFiles: ["src/a.js"],
				type: "ask",
				projectId: 7,
				sequence: 4,
				runId: 42,
				turnId: 101,
				loopId: 55,
				noRepo: true,
				noInteraction: true,
				noWeb: true,
				toolSet: new Set(["get", "set"]),
				contextSize: 32768,
				systemPrompt: "sys",
				loopPrompt: "do the thing",
				writer: "plugin",
			};
			const rummy = new RummyContext(makeRoot(), ctx);

			assert.strictEqual(rummy.hooks, ctx.hooks);
			assert.strictEqual(rummy.db, ctx.db);
			// rummy.entries is a writer-binding proxy around ctx.store;
			// property passthrough proves the underlying store is wired.
			assert.strictEqual(rummy.entries.mark, ctx.store.mark);
			assert.deepStrictEqual(rummy.project, ctx.project);
			assert.deepStrictEqual(rummy.activeFiles, ctx.activeFiles);
			assert.strictEqual(rummy.type, "ask");
			assert.strictEqual(rummy.projectId, 7);
			assert.strictEqual(rummy.sequence, 4);
			assert.strictEqual(rummy.runId, 42);
			assert.strictEqual(rummy.turnId, 101);
			assert.strictEqual(rummy.loopId, 55);
			assert.strictEqual(rummy.noRepo, true);
			assert.strictEqual(rummy.noInteraction, true);
			assert.strictEqual(rummy.noWeb, true);
			assert.strictEqual(rummy.toolSet, ctx.toolSet);
			assert.strictEqual(rummy.contextSize, 32768);
			assert.strictEqual(rummy.systemPrompt, "sys");
			assert.strictEqual(rummy.loopPrompt, "do the thing");
			assert.strictEqual(rummy.writer, "plugin");
		});

		it("falls back to safe defaults when context is sparse", () => {
			const rummy = new RummyContext(makeRoot(), {});

			assert.strictEqual(rummy.hooks, null);
			assert.strictEqual(rummy.entries, null);
			assert.deepStrictEqual(rummy.activeFiles, []);
			assert.strictEqual(rummy.sequence, 0);
			assert.strictEqual(rummy.runId, null);
			assert.strictEqual(rummy.turnId, null);
			assert.strictEqual(rummy.loopId, null);
			assert.strictEqual(rummy.noRepo, false);
			assert.strictEqual(rummy.noInteraction, false);
			assert.strictEqual(rummy.noWeb, false);
			assert.strictEqual(rummy.toolSet, null);
			assert.strictEqual(rummy.contextSize, null);
			assert.strictEqual(rummy.systemPrompt, "");
			assert.strictEqual(rummy.loopPrompt, "");
			assert.strictEqual(rummy.writer, "model");
		});

		it("finds children of the root by tag", () => {
			const rummy = new RummyContext(makeRoot(), {});
			assert.strictEqual(rummy.system.tag, "system");
			assert.strictEqual(rummy.contextEl.tag, "context");
			assert.strictEqual(rummy.user.tag, "user");
			assert.strictEqual(rummy.assistant.tag, "assistant");
		});
	});

	describe("tool verbs delegate to entries", () => {
		function fakeStore() {
			const calls = [];
			const record =
				(method) =>
				(...args) => {
					calls.push([method, args]);
					return method === "getBody" ? "some body" : undefined;
				};
			return {
				calls,
				set: record("set"),
				get: record("get"),
				rm: record("rm"),
				update: record("update"),
				getBody: record("getBody"),
				getAttributes: record("getAttributes"),
				getState: record("getState"),
				getEntriesByPattern: () => [{ path: "x", body: "y" }],
				slugPath: async () => "known://slugged",
			};
		}

		it("set() writes through entries.set with runId and sequence", async () => {
			const store = fakeStore();
			const rummy = new RummyContext(makeRoot(), {
				store,
				runId: 5,
				sequence: 2,
				loopId: 9,
			});
			await rummy.set({
				path: "known://fact",
				body: "the body",
				state: "resolved",
			});
			const [method, args] = store.calls[0];
			assert.strictEqual(method, "set");
			assert.strictEqual(args[0].runId, 5);
			assert.strictEqual(args[0].turn, 2);
			assert.strictEqual(args[0].path, "known://fact");
			assert.strictEqual(args[0].body, "the body");
			assert.strictEqual(args[0].state, "resolved");
		});

		it("rm() delegates to entries.rm", async () => {
			const store = fakeStore();
			const rummy = new RummyContext(makeRoot(), { store, runId: 5 });
			await rummy.rm("known://drop");
			// The entries proxy auto-binds writer to rummy.writer ("model" by default).
			assert.strictEqual(store.calls[0][0], "rm");
			assert.strictEqual(store.calls[0][1][0].runId, 5);
			assert.strictEqual(store.calls[0][1][0].path, "known://drop");
			assert.strictEqual(store.calls[0][1][0].writer, "model");
		});

		it("mv() copies body, writes to new path, removes source", async () => {
			const store = fakeStore();
			const rummy = new RummyContext(makeRoot(), {
				store,
				runId: 5,
				sequence: 1,
			});
			await rummy.mv("a", "b");
			assert.strictEqual(store.calls[0][0], "getBody");
			assert.strictEqual(store.calls[1][0], "set");
			assert.strictEqual(store.calls[2][0], "rm");
		});

		it("cp() copies body without removing source", async () => {
			const store = fakeStore();
			const rummy = new RummyContext(makeRoot(), {
				store,
				runId: 5,
				sequence: 1,
			});
			await rummy.cp("a", "b");
			const methods = store.calls.map((c) => c[0]);
			assert.deepStrictEqual(methods, ["getBody", "set"]);
		});

		it("get() promotes via entries.get", async () => {
			const store = fakeStore();
			const rummy = new RummyContext(makeRoot(), {
				store,
				runId: 5,
				sequence: 2,
			});
			await rummy.get("known://x");
			assert.strictEqual(store.calls[0][0], "get");
			assert.strictEqual(store.calls[0][1][0].runId, 5);
			assert.strictEqual(store.calls[0][1][0].turn, 2);
			assert.strictEqual(store.calls[0][1][0].path, "known://x");
			assert.strictEqual(store.calls[0][1][0].bodyFilter, null);
		});
	});

	describe("query helpers", () => {
		it("getState() returns the state from getState", async () => {
			const rummy = new RummyContext(makeRoot(), {
				store: {
					getState: async () => ({ state: "failed", visibility: "summarized" }),
				},
				runId: 1,
			});
			assert.strictEqual(await rummy.getState("x"), "failed");
		});

		it("getEntry() returns first entry from pattern match", async () => {
			const rummy = new RummyContext(makeRoot(), {
				store: {
					getEntriesByPattern: async () => [{ path: "x", body: "hi" }],
				},
				runId: 1,
			});
			const entry = await rummy.getEntry("x");
			assert.strictEqual(entry.body, "hi");
		});

		it("getEntry() returns null when no match", async () => {
			const rummy = new RummyContext(makeRoot(), {
				store: { getEntriesByPattern: async () => [] },
				runId: 1,
			});
			assert.strictEqual(await rummy.getEntry("x"), null);
		});
	});

	describe("tag() helper", () => {
		it("builds a node with attrs and children", () => {
			const rummy = new RummyContext(makeRoot(), {});
			const node = rummy.tag("x", { foo: "bar" }, [
				"text",
				{ tag: "y", attrs: {}, children: [] },
			]);
			assert.strictEqual(node.tag, "x");
			assert.deepStrictEqual(node.attrs, { foo: "bar" });
			assert.strictEqual(node.content, "text");
			assert.strictEqual(node.children.length, 1);
			assert.strictEqual(node.children[0].tag, "y");
		});
	});
});
