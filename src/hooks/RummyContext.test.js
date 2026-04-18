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
			assert.strictEqual(rummy.entries, ctx.store);
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
			const record = (method) =>
				(...args) => {
					calls.push([method, args]);
					return method === "getBody" ? "some body" : undefined;
				};
			return {
				calls,
				upsert: record("upsert"),
				promoteByPattern: record("promoteByPattern"),
				demoteByPattern: record("demoteByPattern"),
				remove: record("remove"),
				getBody: record("getBody"),
				getAttributes: record("getAttributes"),
				getState: record("getState"),
				getEntriesByPattern: () => [{ path: "x", body: "y" }],
				setAttributes: record("setAttributes"),
				slugPath: async () => "known://slugged",
			};
		}

		it("set() writes through entries.upsert with runId and sequence", async () => {
			const store = fakeStore();
			const rummy = new RummyContext(makeRoot(), {
				store,
				runId: 5,
				sequence: 2,
				loopId: 9,
			});
			await rummy.set({ path: "known://fact", body: "the body", status: 200 });
			const [method, args] = store.calls[0];
			assert.strictEqual(method, "upsert");
			assert.strictEqual(args[0], 5);
			assert.strictEqual(args[1], 2);
			assert.strictEqual(args[2], "known://fact");
			assert.strictEqual(args[3], "the body");
			assert.strictEqual(args[4], 200);
		});

		it("rm() delegates to entries.remove", async () => {
			const store = fakeStore();
			const rummy = new RummyContext(makeRoot(), { store, runId: 5 });
			await rummy.rm("known://drop");
			assert.deepStrictEqual(store.calls[0], ["remove", [5, "known://drop"]]);
		});

		it("mv() copies body then removes source", async () => {
			const store = fakeStore();
			const rummy = new RummyContext(makeRoot(), {
				store,
				runId: 5,
				sequence: 1,
			});
			await rummy.mv("a", "b");
			assert.strictEqual(store.calls[0][0], "getBody");
			assert.strictEqual(store.calls[1][0], "upsert");
			assert.strictEqual(store.calls[2][0], "remove");
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
			assert.deepStrictEqual(methods, ["getBody", "upsert"]);
		});

		it("get() promotes via pattern", async () => {
			const store = fakeStore();
			const rummy = new RummyContext(makeRoot(), {
				store,
				runId: 5,
				sequence: 2,
			});
			await rummy.get("known://x");
			assert.deepStrictEqual(store.calls[0], [
				"promoteByPattern",
				[5, "known://x", null, 2],
			]);
		});

		it("store() demotes via pattern", async () => {
			const store = fakeStore();
			const rummy = new RummyContext(makeRoot(), { store, runId: 5 });
			await rummy.store("known://x");
			assert.deepStrictEqual(store.calls[0], [
				"demoteByPattern",
				[5, "known://x", null],
			]);
		});
	});

	describe("query helpers", () => {
		it("getStatus() returns the status from getState", async () => {
			const rummy = new RummyContext(makeRoot(), {
				store: { getState: async () => ({ status: 413, fidelity: "demoted" }) },
				runId: 1,
			});
			assert.strictEqual(await rummy.getStatus("x"), 413);
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
			const node = rummy.tag("x", { foo: "bar" }, ["text", { tag: "y", attrs: {}, children: [] }]);
			assert.strictEqual(node.tag, "x");
			assert.deepStrictEqual(node.attrs, { foo: "bar" });
			assert.strictEqual(node.content, "text");
			assert.strictEqual(node.children.length, 1);
			assert.strictEqual(node.children[0].tag, "y");
		});
	});
});
