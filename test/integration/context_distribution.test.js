import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import HookRegistry from "../../src/hooks/HookRegistry.js";
import RummyContext from "../../src/hooks/RummyContext.js";
import Engine from "../../src/plugins/engine/engine.js";
import TestDb from "../helpers/TestDb.js";

const RUN_ID = "run-dist-1";
const TURN = 1;

function makeRummy(db, store, { sequence = TURN, contextSize = 50000 } = {}) {
	const hookRoot = {
		tag: "turn",
		attrs: {},
		content: null,
		children: [
			{ tag: "system", attrs: {}, content: null, children: [] },
			{ tag: "context", attrs: {}, content: null, children: [] },
			{ tag: "user", attrs: {}, content: null, children: [] },
			{ tag: "assistant", attrs: {}, content: null, children: [] },
		],
	};
	return new RummyContext(hookRoot, {
		db,
		store,
		project: { id: "p1", path: "/tmp/test", name: "Test" },
		type: "act",
		sequence,
		runId: RUN_ID,
		turnId: 1,
		noContext: false,
		contextSize,
		systemPrompt: "You are a test assistant.",
		loopPrompt: "",
	});
}

describe("turn_context distribution bucket correctness", () => {
	let tdb;
	let store;
	let hooks;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);

		await tdb.db.upsert_project.run({
			id: "p1",
			path: "/tmp/test",
			name: "Test",
		});
		await tdb.db.create_session.run({
			id: "s1",
			project_id: "p1",
			client_id: "c1",
		});
		await tdb.db.create_run.run({
			id: RUN_ID,
			session_id: "s1",
			parent_run_id: null,
			type: "act",
			config: "{}",
			alias: "dist_1",
		});

		// Populate known_entries
		await store.upsert(RUN_ID, 1, "src/app.js", "const x = 1;", "full");
		await store.upsert(RUN_ID, 0, "readme.md", "# Hello", "full");
		await store.upsert(RUN_ID, 1, "known://auth_flow", "JWT tokens", "full");
		await store.upsert(RUN_ID, 1, "read://1", "file contents", "pass");
		await store.upsert(RUN_ID, 1, "summary://1", "did a thing", "summary");
		await store.upsert(RUN_ID, 1, "unknown://1", "what is X?", "full");

		// Materialize turn_context via engine
		hooks = new HookRegistry();
		Engine.register(hooks);
		const rummy = makeRummy(tdb.db, store);
		await hooks.processTurn(rummy);
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("files bucket includes promoted file entries", async () => {
		const dist = await tdb.db.get_turn_distribution.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const files = dist.find((b) => b.bucket === "files");
		assert.ok(files, "files bucket exists");
		assert.ok(files.entries >= 1, "files bucket has entries");
		assert.ok(files.tokens > 0, "files bucket has tokens");
	});

	it("keys bucket includes demoted file entries", async () => {
		const dist = await tdb.db.get_turn_distribution.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const keys = dist.find((b) => b.bucket === "keys");
		assert.ok(keys, "keys bucket exists");
		assert.ok(keys.entries >= 1, "keys bucket has entries");
	});

	it("known bucket includes promoted known entries", async () => {
		const dist = await tdb.db.get_turn_distribution.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const known = dist.find((b) => b.bucket === "known");
		assert.ok(known, "known bucket exists");
		assert.ok(known.entries >= 1, "known bucket has entries");
	});

	it("history bucket includes result and unknown entries", async () => {
		const dist = await tdb.db.get_turn_distribution.all({
			run_id: RUN_ID,
			turn: TURN,
		});
		const history = dist.find((b) => b.bucket === "history");
		assert.ok(history, "history bucket exists");
		assert.ok(history.entries >= 3, "history bucket has results + unknowns");
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
