/**
 * Hook surface — events, filters, and entry change notifications.
 *
 * Covers @events_and_filters — the plugin extension points declared
 * in `Hooks.js`. Tests verify the hooks exist and that the entry
 * change listener fires on upsert / visibility change / remove.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("events and filters (@events_and_filters, @plugins_on, @plugins_filter, @plugins_events_overview, @plugins_project_lifecycle, @plugins_run_loop_lifecycle, @plugins_turn_pipeline, @plugins_entry_events, @plugins_architectural_exceptions)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("events_and_filters");
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("lifecycle hook existence", () => {
		it("project hooks exist", () => {
			assert.ok(tdb.hooks.project.init.started, "project.init.started");
			assert.ok(tdb.hooks.project.init.completed, "project.init.completed");
		});

		it("run, ask/act, loop, proposal hooks exist", () => {
			for (const path of [
				["run", "created"],
				["ask", "started"],
				["ask", "completed"],
				["act", "started"],
				["act", "completed"],
				["run", "step", "completed"],
				["loop", "started"],
				["loop", "completed"],
				["proposal", "prepare"],
				["proposal", "pending"],
			]) {
				let node = tdb.hooks;
				for (const part of path) node = node?.[part];
				assert.ok(node, `${path.join(".")} exists`);
			}
		});

		it("turn pipeline hooks exist", () => {
			for (const path of [
				["turn", "started"],
				["turn", "response"],
				["turn", "completed"],
				["context", "materialized"],
				["assembly", "system"],
				["assembly", "user"],
				["llm", "messages"],
				["llm", "response"],
				["llm", "request", "started"],
				["llm", "request", "completed"],
			]) {
				let node = tdb.hooks;
				for (const part of path) node = node?.[part];
				assert.ok(node, `${path.join(".")} exists`);
			}
		});

		it("entry event hooks exist", () => {
			assert.ok(tdb.hooks.entry.recording);
			assert.ok(tdb.hooks.entry.created);
			assert.ok(tdb.hooks.entry.changed);
			assert.ok(tdb.hooks.tool.before);
			assert.ok(tdb.hooks.tool.after);
		});

		it("budget participates in turn.beforeDispatch + turn.dispatched lifecycle", () => {
			// Budget is a subscriber, not a named-hook-exposing plugin.
			// The orchestration surface is generic — TurnExecutor calls
			// the filter chain and event; budget joined via core.filter
			// and core.on. SPEC: PLUGINS.md @plugins_turn_pipeline.
			assert.ok(
				tdb.hooks.turn.beforeDispatch,
				"turn.beforeDispatch hook exists",
			);
			assert.strictEqual(
				typeof tdb.hooks.turn.beforeDispatch.filter,
				"function",
				"turn.beforeDispatch.filter is callable",
			);
			assert.ok(tdb.hooks.turn.dispatched, "turn.dispatched hook exists");
			assert.strictEqual(
				typeof tdb.hooks.turn.dispatched.emit,
				"function",
				"turn.dispatched.emit is callable",
			);
		});
	});

	describe("entry change notifications", () => {
		it("onChanged fires on upsert", async () => {
			const { runId } = await tdb.seedRun({ alias: "onchanged_upsert" });
			const events = [];
			const store = new Entries(tdb.db, { onChanged: (e) => events.push(e) });
			await store.set({
				runId,
				turn: 1,
				path: "known://upsert_probe",
				body: "body",
				state: "resolved",
			});
			assert.ok(events.length > 0, "onChanged fires on upsert");
			assert.strictEqual(events[0].changeType, "upsert");
		});

		it("onChanged fires on visibility change", async () => {
			const { runId } = await tdb.seedRun({ alias: "onchanged_visibility" });
			const events = [];
			const store = new Entries(tdb.db, { onChanged: (e) => events.push(e) });
			await store.set({
				runId,
				turn: 1,
				path: "known://visibility_probe",
				body: "body",
				state: "resolved",
			});
			events.length = 0;
			await store.set({
				runId,
				path: "known://visibility_probe",
				visibility: "summarized",
			});
			assert.ok(
				events.some((e) => e.changeType === "visibility"),
				"onChanged fires with changeType=visibility",
			);
		});

		it("onChanged fires on remove", async () => {
			const { runId } = await tdb.seedRun({ alias: "onchanged_remove" });
			const events = [];
			const store = new Entries(tdb.db, { onChanged: (e) => events.push(e) });
			await store.set({
				runId,
				turn: 1,
				path: "known://remove_probe",
				body: "body",
				state: "resolved",
			});
			events.length = 0;
			await store.rm({ runId, path: "known://remove_probe" });
			assert.ok(
				events.some((e) => e.changeType === "remove"),
				"onChanged fires with changeType=remove",
			);
		});

		it("entry.changed hook exists for plugin subscription", () => {
			assert.ok(tdb.hooks.entry.changed, "entry.changed hook");
		});
	});
});
