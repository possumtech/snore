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
			assert.ok(tools.has("summarize"), "summarize tool registered");
			assert.ok(tools.has("update"), "update tool registered");
		});

		it("§1.2 ensureTool makes tool appear in tool list", () => {
			const names = tdb.hooks.tools.names;
			assert.ok(names.includes("summarize"), "summarize in tool list");
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
		it("§3.1 ensureTool called explicitly for handler-less tools", () => {
			// summarize, update, unknown have no on("handler") but are in tool list
			const names = tdb.hooks.tools.names;
			assert.ok(names.includes("summarize"));
			assert.ok(names.includes("update"));
			assert.ok(names.includes("unknown"));
		});

		it("§3.2 registerScheme creates DB entries visible in views", async () => {
			// Schemes are used by v_model_context JOIN — if they're missing,
			// entries with those schemes won't materialize
			const { runId } = await tdb.seedRun({ alias: "spec_3_2" });
			const store = new (await import("../../src/agent/KnownStore.js")).default(
				tdb.db,
			);
			await store.upsert(runId, 1, "known://scheme_test", "test", 200);
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
			assert.ok(docsMap.known, "known has tool docs");
			assert.ok(docsMap.rm, "rm has tool docs");
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
				assert.strictEqual(typeof value, "string", `value for ${key} is string`);
			}
		});

		it("§3.7 full view registered for all tools with handlers", () => {
			for (const tool of ["get", "set", "rm", "mv", "cp", "known"]) {
				assert.ok(
					tdb.hooks.tools.hasView(tool),
					`${tool} has view registered`,
				);
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

		it("§7.2 run lifecycle hooks exist", () => {
			assert.ok(tdb.hooks.ask.started, "ask.started exists");
			assert.ok(tdb.hooks.ask.completed, "ask.completed exists");
			assert.ok(tdb.hooks.act.started, "act.started exists");
			assert.ok(tdb.hooks.act.completed, "act.completed exists");
			assert.ok(tdb.hooks.run.progress, "run.progress exists");
			assert.ok(tdb.hooks.run.state, "run.state exists");
		});

		it("§7.3 turn pipeline hooks exist", () => {
			assert.ok(tdb.hooks.turn.started, "turn.started exists");
			assert.ok(tdb.hooks.turn.response, "turn.response exists");
			assert.ok(tdb.hooks.turn.proposing, "turn.proposing exists");
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
			assert.ok(tdb.hooks.entry.created, "entry.created exists");
			assert.ok(tdb.hooks.entry.changed, "entry.changed exists");
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
				? new (await import("../../src/agent/KnownStore.js")).default(tdb.db)
				: null;
			if (!store) return;
			await store.upsert(runId, 1, "known://test", "test body", 200);
			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === "known://test");
			assert.ok(entry, "entry created");
			assert.strictEqual(entry.scheme, "known");
			assert.strictEqual(entry.body, "test body");
			assert.strictEqual(entry.status, 200);
		});
	});

	// TODO sections — tests to implement during refactoring:
	//
	// §2.2 client get goes through same handler as model get
	// §2.3 budget enforcement applies equally to both tiers
	// §4.1 tool verbs on RummyContext work
	// §4.2 query methods on RummyContext work
	// §6 hedberg utilities accessible via core.hooks.hedberg
	// §7.4 entry.changed fires on fidelity/status/body mutations
	// §7.5 budget.enforce returns 413 with overflow on over-budget
	// §8 full entry lifecycle from creation to visibility
	// §11.1 all RPC tool methods go through tool handlers
});
