/**
 * Unified API tests.
 *
 * Covers @unified_api — the three-surface grammar where model (XML),
 * client (JSON-RPC), and plugin (RummyContext) speak the same verbs
 * against the same store.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import RummyContext from "../../src/hooks/RummyContext.js";
import TestDb from "../helpers/TestDb.js";

describe("unified API (@unified_api)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("unified_api");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("model and client see the same tool names", () => {
		// The tool registry serves every surface from one source of truth.
		const names = tdb.hooks.tools.names;
		for (const tool of ["get", "set", "rm", "mv", "cp", "known"]) {
			assert.ok(names.includes(tool), `${tool} available to every surface`);
		}
	});

	it("tool verbs on RummyContext write, read, and remove", async () => {
		const { runId, projectId } = await tdb.seedRun({ alias: "unified_verbs" });
		const store = new Entries(tdb.db);
		const rummy = new RummyContext(
			{ children: [] },
			{ db: tdb.db, store, runId, projectId, sequence: 1, loopId: null },
		);

		const path = await rummy.set({
			path: "known://verb_test",
			body: "hello",
		});
		assert.strictEqual(path, "known://verb_test");

		const body = await rummy.getBody("known://verb_test");
		assert.strictEqual(body, "hello");

		await rummy.rm("known://verb_test");
		const gone = await rummy.getBody("known://verb_test");
		assert.strictEqual(gone, null);
	});

	it("query methods on RummyContext surface attributes and state", async () => {
		const { runId, projectId } = await tdb.seedRun({ alias: "unified_queries" });
		const store = new Entries(tdb.db);
		const rummy = new RummyContext(
			{ children: [] },
			{ db: tdb.db, store, runId, projectId, sequence: 1, loopId: null },
		);

		await rummy.set({
			path: "known://query_a",
			body: "alpha",
			attributes: { tag: "test" },
		});
		await rummy.set({ path: "known://query_b", body: "beta" });

		const entries = await rummy.getEntries("known://*");
		assert.ok(entries.length >= 2, "getEntries returns matches");

		const attrs = await rummy.getAttributes("known://query_a");
		assert.strictEqual(attrs.tag, "test");

		const state = await rummy.getState("known://query_a");
		assert.strictEqual(state, "resolved");

		const entry = await rummy.getEntry("known://query_a");
		assert.ok(entry);
		assert.strictEqual(entry.body, "alpha");
	});
});
