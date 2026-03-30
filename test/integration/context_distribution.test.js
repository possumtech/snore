import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("context_distribution bucket correctness", () => {
	let tdb;
	let store;
	const RUN_ID = "run-dist-1";

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
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("files bucket includes promoted file entries", async () => {
		await store.upsert(RUN_ID, 1, "src/app.js", "const x = 1;", "full");

		const dist = await store.getContextDistribution(RUN_ID);
		const files = dist.find((b) => b.bucket === "files");
		assert.ok(files, "files bucket exists");
		assert.ok(files.entries >= 1, "files bucket has entries");
		assert.ok(files.tokens > 0, "files bucket has tokens");
	});

	it("keys bucket includes demoted file entries", async () => {
		await store.upsert(RUN_ID, 0, "readme.md", "# Hello", "full");

		const dist = await store.getContextDistribution(RUN_ID);
		const keys = dist.find((b) => b.bucket === "keys");
		assert.ok(keys, "keys bucket exists");
		assert.ok(keys.entries >= 1, "keys bucket has entries");
	});

	it("known bucket includes promoted known entries", async () => {
		await store.upsert(RUN_ID, 1, "/:known:auth_flow", "JWT tokens", "full");

		const dist = await store.getContextDistribution(RUN_ID);
		const known = dist.find((b) => b.bucket === "known");
		assert.ok(known, "known bucket exists");
		assert.ok(known.entries >= 1, "known bucket has entries");
	});

	it("history bucket includes result entries", async () => {
		await store.upsert(RUN_ID, 1, "/:read:1", "file contents", "pass");
		await store.upsert(RUN_ID, 1, "/:summary:1", "did a thing", "summary");

		const dist = await store.getContextDistribution(RUN_ID);
		const history = dist.find((b) => b.bucket === "history");
		assert.ok(history, "history bucket exists");
		assert.ok(history.entries >= 2, "history bucket has result entries");
	});

	it("proposed entries excluded from history bucket", async () => {
		await store.upsert(RUN_ID, 1, "/:edit:1", "diff content", "proposed");

		const dist = await store.getContextDistribution(RUN_ID);
		const history = dist.find((b) => b.bucket === "history");
		const historyEntries = history ? history.entries : 0;

		// proposed should not count toward history
		await store.upsert(RUN_ID, 1, "/:edit:2", "another diff", "proposed");
		const dist2 = await store.getContextDistribution(RUN_ID);
		const history2 = dist2.find((b) => b.bucket === "history");
		assert.strictEqual(
			history2 ? history2.entries : 0,
			historyEntries,
			"adding proposed entries should not increase history count",
		);
	});

	it("unknowns counted in history bucket", async () => {
		const distBefore = await store.getContextDistribution(RUN_ID);
		const histBefore = distBefore.find((b) => b.bucket === "history");
		const countBefore = histBefore ? histBefore.entries : 0;

		await store.upsert(RUN_ID, 1, "/:unknown:1", "what is X?", "full");

		const distAfter = await store.getContextDistribution(RUN_ID);
		const histAfter = distAfter.find((b) => b.bucket === "history");
		assert.ok(
			histAfter.entries > countBefore,
			"unknown adds to history bucket",
		);
	});

	it("all buckets have numeric tokens and entries", async () => {
		const dist = await store.getContextDistribution(RUN_ID);
		assert.ok(dist.length > 0, "distribution is non-empty");
		for (const bucket of dist) {
			assert.ok(typeof bucket.bucket === "string", "bucket name is string");
			assert.ok(typeof bucket.tokens === "number", "tokens is number");
			assert.ok(typeof bucket.entries === "number", "entries is number");
		}
	});
});
