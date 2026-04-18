/**
 * PLUGINS.md spec compliance tests.
 *
 * Each test is numbered to match the corresponding section in PLUGINS.md.
 * If a test fails, the documentation and implementation are out of sync.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import TestDb from "../helpers/TestDb.js";

describe("PLUGINS.md Spec Compliance", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("plugin_spec");
	});

	after(async () => {
		await tdb.cleanup();
	});

	// §1 Plugin Contract
	describe("§1 Plugin Contract", () => {
		it("§1.1 plugins register via constructor with PluginContext", () => {
			// Every bundled plugin should have registered
			const tools = tdb.hooks.tools;
			assert.ok(tools.has("get"), "get tool registered");
			assert.ok(tools.has("set"), "set tool registered");
			assert.ok(tools.has("rm"), "rm tool registered");
			assert.ok(tools.has("known"), "known tool registered");
			assert.ok(tools.has("unknown"), "unknown tool registered");
			assert.ok(tools.has("update"), "update tool registered");
		});

		it("§1.2 ensureTool makes tool appear in tool list", () => {
			const names = tdb.hooks.tools.names;
			assert.ok(names.includes("update"), "update in tool list");
			assert.ok(names.includes("unknown"), "unknown in tool list");
		});
	});

	// §2 Unified API
	describe("§2 Unified API", () => {
		it("§2.1 model and client tool names match", () => {
			// The tool registry serves both model and client
			const names = tdb.hooks.tools.names;
			for (const tool of ["get", "set", "rm", "mv", "cp", "known"]) {
				assert.ok(names.includes(tool), `${tool} available to both tiers`);
			}
		});

		// TODO: §2.2 client get goes through same handler as model get
		// TODO: §2.3 budget enforcement applies equally to both tiers
	});

	// §3 Registration
	describe("§3 Registration", () => {
		it("§3.0 CATEGORIES is frozen with exactly four roles", async () => {
			const PluginContext = (await import("../../src/hooks/PluginContext.js"))
				.default;
			const cats = PluginContext.CATEGORIES;
			assert.ok(Object.isFrozen(cats), "CATEGORIES is frozen");
			assert.strictEqual(cats.size, 4);
			assert.ok(cats.has("data"));
			assert.ok(cats.has("logging"));
			assert.ok(cats.has("unknown"));
			assert.ok(cats.has("prompt"));
		});

		it("§3.0.1 registerScheme rejects invalid categories", async () => {
			const PluginContext = (await import("../../src/hooks/PluginContext.js"))
				.default;
			const ctx = new PluginContext("test_invalid", tdb.hooks);
			assert.throws(
				() => ctx.registerScheme({ category: "structural" }),
				/Invalid category/,
			);
		});

		it("§3.1 ensureTool called explicitly for handler-less tools", () => {
			// update, unknown have no on("handler") but are in tool list
			const names = tdb.hooks.tools.names;
			assert.ok(names.includes("update"));
			assert.ok(names.includes("unknown"));
		});

		it("§3.2 registerScheme creates DB entries visible in views", async () => {
			// Schemes are used by v_model_context JOIN — if they're missing,
			// entries with those schemes won't materialize
			const { runId } = await tdb.seedRun({ alias: "spec_3_2" });
			const store = new (await import("../../src/agent/Repository.js")).default(
				tdb.db,
			);
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

		it("§3.3 on('handler') auto-calls ensureTool", () => {
			// get, set, rm all register handlers and should be in tool list
			const names = tdb.hooks.tools.names;
			assert.ok(names.includes("get"));
			assert.ok(names.includes("set"));
			assert.ok(names.includes("rm"));
		});

		it("§3.4 filter('instructions.toolDocs') populates docs", async () => {
			const docsMap = await tdb.hooks.instructions.toolDocs.filter(
				{},
				{ toolSet: new Set(tdb.hooks.tools.names) },
			);
			assert.ok(docsMap.get, "get has tool docs");
			assert.ok(docsMap.set, "set has tool docs");
			assert.ok(docsMap.rm, "rm has tool docs");
			// known/unknown are hidden internal schemes — no toolDocs registered.
		});

		it("§3.5 tool docs use docsMap pattern not string concat", async () => {
			const docsMap = await tdb.hooks.instructions.toolDocs.filter(
				{},
				{ toolSet: new Set(tdb.hooks.tools.names) },
			);
			// docsMap should be an object with tool names as keys
			assert.strictEqual(typeof docsMap, "object");
			assert.ok(!Array.isArray(docsMap));
			for (const [key, value] of Object.entries(docsMap)) {
				assert.strictEqual(typeof key, "string", `key ${key} is string`);
				assert.strictEqual(
					typeof value,
					"string",
					`value for ${key} is string`,
				);
			}
		});

		it("§3.7 full view registered for all tools with handlers", () => {
			for (const tool of ["get", "set", "rm", "mv", "cp", "known"]) {
				assert.ok(tdb.hooks.tools.hasView(tool), `${tool} has view registered`);
			}
		});
	});

	// §5 Tool Display Order
	describe("§5 Tool Display Order", () => {
		it("§5.1 tools sorted by priority not alphabetically", () => {
			const names = tdb.hooks.tools.names;
			const getIdx = names.indexOf("get");
			const askUserIdx = names.indexOf("ask_user");
			assert.ok(getIdx < askUserIdx, "get before ask_user");
		});

		it("§5.2 ask mode excludes sh", () => {
			const tools = tdb.hooks.tools.resolveForLoop("ask");
			assert.ok(!tools.has("sh"), "sh excluded in ask mode");
			assert.ok(tools.has("get"), "get available in ask mode");
		});

		it("§5.3 noInteraction excludes ask_user", () => {
			const tools = tdb.hooks.tools.resolveForLoop("ask", {
				noInteraction: true,
			});
			assert.ok(!tools.has("ask_user"), "ask_user excluded");
		});

		it("§5.4 noWeb excludes search", () => {
			const tools = tdb.hooks.tools.resolveForLoop("ask", { noWeb: true });
			assert.ok(!tools.has("search"), "search excluded");
		});
	});

	// §7 Events & Filters
	describe("§7 Events & Filters", () => {
		it("§7.1 project lifecycle hooks exist", () => {
			assert.ok(tdb.hooks.project.init.started, "project.init.started exists");
			assert.ok(
				tdb.hooks.project.init.completed,
				"project.init.completed exists",
			);
		});

		it("§7.2 run and loop lifecycle hooks exist", () => {
			assert.ok(tdb.hooks.run.created, "run.created exists");
			assert.ok(tdb.hooks.ask.started, "ask.started exists");
			assert.ok(tdb.hooks.ask.completed, "ask.completed exists");
			assert.ok(tdb.hooks.act.started, "act.started exists");
			assert.ok(tdb.hooks.act.completed, "act.completed exists");
			assert.ok(tdb.hooks.run.progress, "run.progress exists");
			assert.ok(tdb.hooks.run.state, "run.state exists");
			assert.ok(tdb.hooks.loop.started, "loop.started exists");
			assert.ok(tdb.hooks.loop.completed, "loop.completed exists");
		});

		it("§7.3 turn pipeline hooks exist", () => {
			assert.ok(tdb.hooks.turn.started, "turn.started exists");
			assert.ok(tdb.hooks.turn.response, "turn.response exists");
			assert.ok(tdb.hooks.turn.proposing, "turn.proposing exists");
			assert.ok(tdb.hooks.turn.completed, "turn.completed exists");
			assert.ok(tdb.hooks.context.materialized, "context.materialized exists");
			assert.ok(tdb.hooks.assembly.system, "assembly.system exists");
			assert.ok(tdb.hooks.assembly.user, "assembly.user exists");
			assert.ok(tdb.hooks.llm.messages, "llm.messages exists");
			assert.ok(tdb.hooks.llm.response, "llm.response exists");
			assert.ok(tdb.hooks.llm.request.started, "llm.request.started exists");
			assert.ok(
				tdb.hooks.llm.request.completed,
				"llm.request.completed exists",
			);
		});

		it("§7.4 entry event hooks exist", () => {
			assert.ok(tdb.hooks.entry.recording, "entry.recording exists");
			assert.ok(tdb.hooks.entry.created, "entry.created exists");
			assert.ok(tdb.hooks.entry.changed, "entry.changed exists");
			assert.ok(tdb.hooks.tool.before, "tool.before exists");
			assert.ok(tdb.hooks.tool.after, "tool.after exists");
		});

		it("§7.5 budget hook exists", () => {
			assert.ok(tdb.hooks.budget, "budget hook exists");
			assert.ok(
				typeof tdb.hooks.budget.enforce === "function",
				"budget.enforce is callable",
			);
		});
	});

	// §8 Entry Lifecycle
	describe("§8 Entry Lifecycle", () => {
		it("§8.1 entries created with scheme, path, body, status", async () => {
			const { runId } = await tdb.seedRun({ alias: "spec_8_1" });
			const store = tdb.hooks.tools.names.includes("known")
				? new (await import("../../src/agent/Repository.js")).default(tdb.db)
				: null;
			if (!store) return;
			await store.set({
				runId,
				turn: 1,
				path: "known://test",
				body: "test body",
				state: "resolved",
			});
			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "known://test");
			assert.ok(entry, "entry created");
			assert.strictEqual(entry.scheme, "known");
			assert.strictEqual(entry.body, "test body");
			assert.strictEqual(entry.state, "resolved");
		});
	});

	// §7.4 Entry Events
	describe("§7.4 Entry Events", () => {
		it("§7.4.1 Repository emits onChanged on upsert", async () => {
			const { runId } = await tdb.seedRun({ alias: "spec_7_4_1" });
			const events = [];
			const store = new (await import("../../src/agent/Repository.js")).default(
				tdb.db,
				{ onChanged: (e) => events.push(e) },
			);
			await store.set({
				runId,
				turn: 1,
				path: "known://test_changed",
				body: "body",
				state: "resolved",
			});
			assert.ok(events.length > 0, "onChanged should fire on upsert");
			assert.strictEqual(events[0].changeType, "upsert");
		});

		it("§7.4.2 Repository emits onChanged on fidelity change", async () => {
			const { runId } = await tdb.seedRun({ alias: "spec_7_4_2" });
			const events = [];
			const store = new (await import("../../src/agent/Repository.js")).default(
				tdb.db,
				{ onChanged: (e) => events.push(e) },
			);
			await store.set({
				runId,
				turn: 1,
				path: "known://fidelity_test",
				body: "body",
				state: "resolved",
			});
			events.length = 0;
			await store.set({
				runId: runId,
				path: "known://fidelity_test",
				fidelity: "demoted",
			});
			assert.ok(
				events.some((e) => e.changeType === "fidelity"),
				"onChanged should fire with changeType=fidelity",
			);
		});

		it("§7.4.3 Repository emits onChanged on remove", async () => {
			const { runId } = await tdb.seedRun({ alias: "spec_7_4_3" });
			const events = [];
			const store = new (await import("../../src/agent/Repository.js")).default(
				tdb.db,
				{ onChanged: (e) => events.push(e) },
			);
			await store.set({
				runId,
				turn: 1,
				path: "known://remove_test",
				body: "body",
				state: "resolved",
			});
			events.length = 0;
			await store.rm({ runId: runId, path: "known://remove_test" });
			assert.ok(
				events.some((e) => e.changeType === "remove"),
				"onChanged should fire with changeType=remove",
			);
		});

		it("§7.4.4 entry.changed hook exists for plugin subscription", () => {
			assert.ok(tdb.hooks.entry.changed, "entry.changed hook exists");
		});
	});

	// §4 Two Objects
	describe("§4 Two Objects", () => {
		it("§4.1 tool verbs on RummyContext work", async () => {
			const { runId, projectId } = await tdb.seedRun({ alias: "spec_4_1" });
			const RummyContext = (await import("../../src/hooks/RummyContext.js"))
				.default;
			const Repository = (await import("../../src/agent/Repository.js"))
				.default;
			const store = new Repository(tdb.db);
			const rummy = new RummyContext(
				{ children: [] },
				{
					db: tdb.db,
					store,
					runId,
					projectId,
					sequence: 1,
					loopId: null,
				},
			);

			// set
			const path = await rummy.set({
				path: "known://verb_test",
				body: "hello",
			});
			assert.strictEqual(path, "known://verb_test");

			// getBody (query)
			const body = await rummy.getBody("known://verb_test");
			assert.strictEqual(body, "hello");

			// rm
			await rummy.rm("known://verb_test");
			const gone = await rummy.getBody("known://verb_test");
			assert.strictEqual(gone, null);
		});

		it("§4.2 query methods on RummyContext work", async () => {
			const { runId, projectId } = await tdb.seedRun({ alias: "spec_4_2" });
			const RummyContext = (await import("../../src/hooks/RummyContext.js"))
				.default;
			const Repository = (await import("../../src/agent/Repository.js"))
				.default;
			const store = new Repository(tdb.db);
			const rummy = new RummyContext(
				{ children: [] },
				{
					db: tdb.db,
					store,
					runId,
					projectId,
					sequence: 1,
					loopId: null,
				},
			);

			await rummy.set({
				path: "known://query_a",
				body: "alpha",
				attributes: { tag: "test" },
			});
			await rummy.set({ path: "known://query_b", body: "beta" });

			// getEntries
			const entries = await rummy.getEntries("known://*");
			assert.ok(entries.length >= 2, "getEntries returns matches");

			// getAttributes
			const attrs = await rummy.getAttributes("known://query_a");
			assert.strictEqual(attrs.tag, "test");

			// getState
			const state = await rummy.getState("known://query_a");
			assert.strictEqual(state, "resolved");

			// getEntry
			const entry = await rummy.getEntry("known://query_a");
			assert.ok(entry);
			assert.strictEqual(entry.body, "alpha");
		});
	});

	// §6 Hedberg
	describe("§6 Hedberg", () => {
		it("§6.1 hedberg utilities accessible via core.hooks.hedberg", () => {
			const h = tdb.hooks.hedberg;
			assert.ok(h, "hedberg object exists on hooks");
			assert.strictEqual(typeof h.match, "function", "match");
			assert.strictEqual(typeof h.search, "function", "search");
			assert.strictEqual(typeof h.replace, "function", "replace");
			assert.strictEqual(typeof h.parseSed, "function", "parseSed");
			assert.strictEqual(typeof h.parseEdits, "function", "parseEdits");
			assert.strictEqual(typeof h.normalizeAttrs, "function", "normalizeAttrs");
			assert.strictEqual(typeof h.generatePatch, "function", "generatePatch");
		});
	});

	// §7.5 Budget enforce
	describe("§7.5 Budget Enforce", () => {
		it("§7.5.1 budget.enforce returns overflow on over-budget", async () => {
			const bigMessage = "x".repeat(100000);
			const result = await tdb.hooks.budget.enforce({
				contextSize: 1000,
				messages: [{ role: "system", content: bigMessage }],
				rows: [],
			});
			assert.strictEqual(result.ok, false);
			assert.ok(result.overflow > 0, "overflow is positive");
			assert.ok(result.assembledTokens > 1000, "assembled exceeds ceiling");
		});

		it("§7.5.2 budget.enforce returns ok when under budget", async () => {
			const result = await tdb.hooks.budget.enforce({
				contextSize: 100000,
				messages: [{ role: "system", content: "small" }],
				rows: [],
			});
			assert.strictEqual(result.ok, true);
		});
	});

	// §8 Full Entry Lifecycle
	describe("§8 Full Entry Lifecycle", () => {
		it("§8.2 entry visible in v_model_context after creation", async () => {
			const { runId } = await tdb.seedRun({ alias: "spec_8_2" });
			const Repository = (await import("../../src/agent/Repository.js"))
				.default;
			const store = new Repository(tdb.db);
			await store.set({
				runId,
				turn: 1,
				path: "known://lifecycle_vis",
				body: "visible",
				state: "resolved",
			});

			const rows = await tdb.db.get_model_context.all({ run_id: runId });
			const row = rows.find((r) => r.path === "known://lifecycle_vis");
			assert.ok(row, "entry appears in v_model_context");
			assert.strictEqual(row.fidelity, "promoted");
		});

		it("§8.3 stored fidelity hides from v_model_context", async () => {
			const { runId } = await tdb.seedRun({ alias: "spec_8_3" });
			const Repository = (await import("../../src/agent/Repository.js"))
				.default;
			const store = new Repository(tdb.db);
			await store.set({
				runId,
				turn: 1,
				path: "known://lifecycle_stored",
				body: "hidden",
				state: "resolved",
				fidelity: "archived",
			});

			const rows = await tdb.db.get_model_context.all({ run_id: runId });
			const row = rows.find((r) => r.path === "known://lifecycle_stored");
			assert.ok(!row, "stored entry not in v_model_context");
		});
	});
});
