import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import materialize from "../helpers/materialize.js";
import TestDb from "../helpers/TestDb.js";

let RUN_ID;
const TURN = 1;

describe("turn_context distribution bucket correctness", () => {
	let tdb;
	let store;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun({ alias: "dist_1" });
		RUN_ID = seed.runId;

		// Populate known_entries
		await store.upsert(RUN_ID, 1, "src/app.js", "const x = 1;", "resolved");
		await store.upsert(RUN_ID, 1, "readme.md", "# Hello", "resolved", {
			fidelity: "demoted",
		});
		await store.upsert(
			RUN_ID,
			1,
			"known://auth_flow",
			"JWT tokens",
			"resolved",
		);
		await store.upsert(RUN_ID, 1, "search://1", "search results", "resolved");
		await store.upsert(RUN_ID, 1, "update://1", "did a thing", "resolved", {
			fidelity: "demoted",
		});
		await store.upsert(RUN_ID, 1, "unknown://1", "what is X?", "resolved");
		await store.upsert(RUN_ID, 1, "prompt://1", "test question", "resolved", {
			attributes: { mode: "ask" },
		});

		// Materialize turn_context
		await materialize(tdb.db, {
			runId: RUN_ID,
			turn: TURN,
			systemPrompt: "You are a test assistant.",
		});
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("data bucket includes files and known entries", async () => {
		const dist = await tdb.db.get_turn_distribution.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const data = dist.find((b) => b.bucket === "data");
		assert.ok(data, "data bucket exists");
		assert.ok(data.entries >= 2, "data bucket has file + known entries");
		assert.ok(data.tokens > 0, "data bucket has tokens");
	});

	it("logging bucket includes result entries", async () => {
		const dist = await tdb.db.get_turn_distribution.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const logging = dist.find((b) => b.bucket === "logging");
		assert.ok(logging, "logging bucket exists");
		assert.ok(logging.entries >= 1, "logging bucket has result entries");
	});

	it("unknown bucket includes unknown entries", async () => {
		const dist = await tdb.db.get_turn_distribution.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const unknown = dist.find((b) => b.bucket === "unknown");
		assert.ok(unknown, "unknown bucket exists");
		assert.ok(unknown.entries >= 1, "unknown bucket has entries");
	});

	it("system bucket includes system prompt", async () => {
		const dist = await tdb.db.get_turn_distribution.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const system = dist.find((b) => b.bucket === "system");
		assert.ok(system, "system bucket exists");
		assert.ok(system.tokens > 0, "system bucket has tokens");
	});

	it("all buckets have numeric tokens and entries", async () => {
		const dist = await tdb.db.get_turn_distribution.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		assert.ok(dist.length > 0, "distribution is non-empty");
		for (const bucket of dist) {
			assert.ok(typeof bucket.bucket === "string", "bucket name is string");
			assert.ok(typeof bucket.tokens === "number", "tokens is number");
			assert.ok(typeof bucket.entries === "number", "entries is number");
		}
	});

	it("total budget matches sum of all turn_context tokens", async () => {
		const { total } = await tdb.db.get_turn_budget.get({
			run_id: RUN_ID,
			turn: TURN,
		});
		const rows = await tdb.db.get_turn_context.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const sum = rows.reduce((s, r) => s + r.tokens, 0);
		assert.strictEqual(total, sum, "budget query matches row-level sum");
		assert.ok(total > 0, "total is non-zero");
	});
});
